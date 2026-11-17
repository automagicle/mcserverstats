package dev.mcserverstats.chatlog;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

// Queues messages in memory and POSTs them to the dashboard in batches from a background
// thread, so the game never waits on the network. If the dashboard can't be reached, messages
// wait in the queue and are retried with backoff; anything still unsent at shutdown is saved
// to disk and sent after the next start. Each message has a unique id, so a retry of a batch
// that actually arrived is ignored by the dashboard.
final class Uploader {
	private static final int BATCH = 100;
	private static final int MAX_QUEUE = 20_000;
	private static final long FLUSH_MS = 3_000;
	private static final long MAX_BACKOFF_MS = 5 * 60_000;
	private static final long REPEAT_WARNING_MS = 10 * 60_000;

	private final Path configFile;
	private final Path pendingFile;
	private final String userAgent;
	private final String runId = HexFormat.of().formatHex(new SecureRandom().generateSeed(6));
	private final AtomicLong seq = new AtomicLong();
	private final ArrayDeque<JsonObject> queue = new ArrayDeque<>();
	// Each player's latest gear report waiting to be sent (a newer one replaces an unsent older one).
	private final Map<UUID, JsonObject> gear = new LinkedHashMap<>();
	// The same for each player's advancements, and the advancement tree when it has yet to be sent.
	private final Map<UUID, JsonObject> advancements = new LinkedHashMap<>();
	private JsonObject advancementTree;
	// The latest list of who's online, until it's sent (a newer one replaces it).
	private JsonObject online;
	private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

	private volatile Config config = Config.EMPTY;
	private long configModified = -1;
	private ScheduledExecutorService exec;
	private volatile long lastFlush;
	private long nextAttempt;
	private long backoff;
	private String lastWarning;
	private long lastWarningAt;
	private int dropped;
	private boolean connected;

	Uploader(Path configFile, Path pendingFile, String version) {
		this.configFile = configFile;
		this.pendingFile = pendingFile;
		this.userAgent = "mcstats-chat/" + version;
		reloadConfig();
	}

	boolean systemMessages() {
		return config.systemMessages();
	}

	Config config() {
		return config;
	}

	// Called from the server thread.
	void add(String kind, UUID uuid, String name, JsonArray display, JsonArray rich, String text) {
		add(kind, uuid, name, display, rich, text, null);
	}

	// via: "web" for chat sent from the dashboard.
	void add(String kind, UUID uuid, String name, JsonArray display, JsonArray rich, String text, String via) {
		add(kind, uuid, name, display, rich, text, via, null);
	}

	// death: for a death message, how it happened ({ cause, killer?, killer_uuid?, mob?, weapon? }).
	void add(String kind, UUID uuid, String name, JsonArray display, JsonArray rich, String text, String via, JsonObject death) {
		if (text == null || text.isBlank()) return;
		JsonObject e = new JsonObject();
		e.addProperty("id", runId + "-" + seq.incrementAndGet());
		e.addProperty("ts", System.currentTimeMillis());
		e.addProperty("kind", kind);
		if (uuid != null) e.addProperty("uuid", uuid.toString());
		if (name != null) e.addProperty("name", name);
		if (display != null) e.add("display", display);
		if (rich != null) e.add("rich", rich);
		e.addProperty("text", text);
		if (via != null) e.addProperty("via", via);
		if (death != null) e.add("death", death);
		synchronized (queue) {
			queue.addLast(e);
			while (queue.size() > MAX_QUEUE) {
				queue.removeFirst();
				dropped++;
			}
		}
	}

	// Send what's queued at the next tick rather than waiting out the batching delay (so a message
	// sent from the dashboard shows in its chat log quickly).
	void flushSoon() {
		lastFlush = 0;
	}

	// Called from the server thread.
	void addGear(UUID player, JsonObject report) {
		synchronized (gear) {
			gear.remove(player);
			gear.put(player, report);
		}
	}

	// Called from the server thread.
	void addAdvancements(UUID player, JsonObject report) {
		synchronized (advancements) {
			advancements.remove(player);
			advancements.put(player, report);
		}
	}

	// Called from the server thread.
	void setAdvancementTree(JsonObject tree) {
		synchronized (advancements) {
			advancementTree = tree;
		}
	}

	// Called from the server thread.
	void setOnline(JsonObject report) {
		synchronized (this) {
			online = report;
		}
	}

	void start() {
		if (exec != null) return;
		loadPending();
		exec = Executors.newSingleThreadScheduledExecutor(r -> {
			Thread t = new Thread(r, "mcstats-chat-upload");
			t.setDaemon(true);
			return t;
		});
		exec.scheduleWithFixedDelay(this::tick, 1, 1, TimeUnit.SECONDS);
	}

	// One last try to send what's left (briefly, so shutdown isn't held up), then save the rest.
	void stop() {
		if (exec == null) return;
		exec.shutdownNow();
		try {
			exec.awaitTermination(3, TimeUnit.SECONDS);
		} catch (InterruptedException ignored) {
			Thread.currentThread().interrupt();
		}
		exec = null;
		if (config.ready()) {
			long deadline = System.currentTimeMillis() + 5_000;
			while (System.currentTimeMillis() < deadline && sendBatch(Duration.ofSeconds(4))) { }
			sendOnline(Duration.ofSeconds(3)); // "nobody's on" (OnlineReporter.stopping)
		}
		savePending();
	}

	private void tick() {
		try {
			reloadConfig();
			long now = System.currentTimeMillis();
			if (!config.ready() || now < nextAttempt) return;
			if (now - lastFlush < FLUSH_MS && size() < BATCH) return;
			lastFlush = now;
			while (sendBatch(Duration.ofSeconds(15))) { }
			if (now >= nextAttempt) sendOnline(Duration.ofSeconds(10));
			if (now >= nextAttempt) sendGear();
			if (now >= nextAttempt) sendAdvancements();
		} catch (Throwable t) {
			ChatLogMod.LOG.error("Chat upload failed unexpectedly", t);
		}
	}

	private int size() {
		synchronized (queue) {
			return queue.size();
		}
	}

	// Sends up to one batch. Returns true if it went through and more are waiting.
	private boolean sendBatch(Duration timeout) {
		List<JsonObject> batch;
		int lost;
		synchronized (queue) {
			batch = new ArrayList<>(Math.min(BATCH, queue.size()));
			for (JsonObject e : queue) {
				if (batch.size() == BATCH) break;
				batch.add(e);
			}
			lost = dropped;
			dropped = 0;
		}
		if (lost > 0) ChatLogMod.LOG.warn("Chat queue was full; the oldest {} messages were dropped", lost);
		if (batch.isEmpty()) return false;

		JsonArray events = new JsonArray();
		batch.forEach(events::add);
		JsonObject body = new JsonObject();
		body.add("events", events);

		Reply r = post(config.url(), body, timeout);
		if (r == null) return false;
		int status = r.status();
		String reply = r.body();
		boolean fromAccess = r.fromAccess();
		if (status >= 200 && status < 300) {
			if (lastWarning != null) ChatLogMod.LOG.info("Chat log is reaching the dashboard again");
			else if (!connected) ChatLogMod.LOG.info("Chat log connected; messages are reaching the dashboard");
			connected = true;
			lastWarning = null;
			backoff = 0;
			remove(batch);
			return size() > 0;
		}
		if (status == 400 || status == 413) {
			// Retrying the same data won't help.
			ChatLogMod.LOG.error("Dashboard rejected {} chat messages (HTTP {}): {}", batch.size(), status, trim(reply));
			remove(batch);
			return size() > 0;
		}
		fail(why(status, fromAccess));
		return false;
	}

	private record Reply(int status, String body, boolean fromAccess) {}

	// One POST with the token and Access headers. Null if the dashboard couldn't be reached.
	private Reply post(String url, JsonObject body, Duration timeout) {
		Config c = config;
		try {
			HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(url))
					.timeout(timeout)
					.header("Content-Type", "application/json")
					.header("Authorization", "Bearer " + c.token())
					.header("User-Agent", userAgent)
					.POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8));
			if (!c.accessClientId().isEmpty()) {
				req.header("CF-Access-Client-Id", c.accessClientId());
				req.header("CF-Access-Client-Secret", c.accessClientSecret());
			}
			HttpResponse<String> res = http.send(req.build(), HttpResponse.BodyHandlers.ofString());
			// Access answers with its own HTML page; the Worker answers with JSON
			return new Reply(res.statusCode(), res.body(),
					!res.headers().firstValue("Content-Type").orElse("").contains("application/json"));
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			return null;
		} catch (Exception e) {
			fail("couldn't reach the dashboard (" + e.getClass().getSimpleName()
					+ (e.getMessage() != null ? ": " + e.getMessage() : "") + ")");
			return null;
		}
	}

	// Sends the latest list of who's online to /api/ingest/online next to the chat url. An older
	// dashboard without that endpoint (404) is skipped quietly.
	private void sendOnline(Duration timeout) {
		JsonObject report;
		synchronized (this) {
			report = online;
		}
		if (report == null) return;
		Reply r = post(config.url().replaceFirst("/chat/?$", "/online"), report, timeout);
		if (r == null) return;
		boolean done = r.status() >= 200 && r.status() < 300;
		if (done || r.status() == 400 || r.status() == 404 || r.status() == 413) {
			if (!done && r.status() != 404) ChatLogMod.LOG.error("Dashboard rejected the online list (HTTP {}): {}", r.status(), trim(r.body()));
			synchronized (this) {
				if (online == report) online = null; // unless a newer one came in meanwhile
			}
			return;
		}
		fail(why(r.status(), r.fromAccess()));
	}

	// Sends every waiting gear report in one request, to /api/ingest/gear next to the chat url.
	// An older dashboard without that endpoint (404) is skipped quietly; the reports are dropped.
	private void sendGear() {
		JsonArray players = new JsonArray();
		List<UUID> ids = new ArrayList<>();
		synchronized (gear) {
			gear.forEach((id, report) -> {
				ids.add(id);
				players.add(report);
			});
		}
		if (players.isEmpty()) return;
		JsonObject body = new JsonObject();
		body.add("players", players);
		Reply r = post(config.url().replaceFirst("/chat/?$", "/gear"), body, Duration.ofSeconds(15));
		if (r == null) return;
		boolean done = r.status() >= 200 && r.status() < 300;
		if (done || r.status() == 400 || r.status() == 404 || r.status() == 413) {
			if (!done && r.status() != 404) ChatLogMod.LOG.error("Dashboard rejected gear (HTTP {}): {}", r.status(), trim(r.body()));
			synchronized (gear) {
				for (UUID id : ids) {
					JsonObject sent = players.get(ids.indexOf(id)).getAsJsonObject();
					if (gear.get(id) == sent) gear.remove(id); // unless a newer report came in meanwhile
				}
			}
			return;
		}
		fail(why(r.status(), r.fromAccess()));
	}

	// Sends the advancement tree (when it's new) and every waiting player's advancements in one
	// request, to /api/ingest/advancements next to the chat url. An older dashboard without that
	// endpoint (404) is skipped quietly.
	private void sendAdvancements() {
		JsonArray players = new JsonArray();
		List<UUID> ids = new ArrayList<>();
		JsonObject tree;
		synchronized (advancements) {
			tree = advancementTree;
			advancements.forEach((id, report) -> {
				if (ids.size() < 25) { // a full server's worth goes out over a few requests
					ids.add(id);
					players.add(report);
				}
			});
		}
		if (players.isEmpty() && tree == null) return;
		JsonObject body = new JsonObject();
		if (tree != null) body.add("tree", tree);
		body.add("players", players);
		Reply r = post(config.url().replaceFirst("/chat/?$", "/advancements"), body, Duration.ofSeconds(15));
		if (r == null) return;
		boolean done = r.status() >= 200 && r.status() < 300;
		if (done || r.status() == 400 || r.status() == 404 || r.status() == 413) {
			if (!done && r.status() != 404) ChatLogMod.LOG.error("Dashboard rejected advancements (HTTP {}): {}", r.status(), trim(r.body()));
			synchronized (advancements) {
				if (advancementTree == tree) advancementTree = null;
				for (int i = 0; i < ids.size(); i++) {
					if (advancements.get(ids.get(i)) == players.get(i).getAsJsonObject()) advancements.remove(ids.get(i));
				}
			}
			return;
		}
		fail(why(r.status(), r.fromAccess()));
	}

	static String why(int status, boolean fromAccess) {
		return switch (status) {
			case 401 -> fromAccess
					? "Cloudflare Access doesn't recognise access_client_id / access_client_secret (deleted token or wrong secret)"
					: "the token doesn't match CHAT_INGEST_TOKEN on the Worker";
			case 503 -> "the Worker doesn't have a CHAT_INGEST_TOKEN secret yet";
			case 403 -> "Cloudflare Access knows this service token, but no Service Auth policy on the app allows it";
			case 301, 302, 303, 307, 308 -> "Cloudflare Access sent it to the login page (HTTP " + status
					+ "); check access_client_id / access_client_secret";
			case 404 -> "the url isn't right (HTTP 404); it should end in /api/ingest/chat";
			default -> "the dashboard answered HTTP " + status;
		};
	}

	private void remove(List<JsonObject> sent) {
		Set<JsonObject> ids = Collections.newSetFromMap(new IdentityHashMap<>());
		ids.addAll(sent);
		synchronized (queue) {
			while (!queue.isEmpty() && ids.contains(queue.peekFirst())) queue.removeFirst();
		}
	}

	private void fail(String why) {
		long now = System.currentTimeMillis();
		backoff = Math.min(MAX_BACKOFF_MS, Math.max(5_000, backoff * 2));
		nextAttempt = now + backoff;
		if (!why.equals(lastWarning) || now - lastWarningAt > REPEAT_WARNING_MS) {
			ChatLogMod.LOG.warn("Couldn't send chat: {}. {} messages waiting; retrying in {}s", why, size(), backoff / 1000);
			lastWarning = why;
			lastWarningAt = now;
		}
	}

	private void reloadConfig() {
		try {
			long modified = Files.exists(configFile) ? Files.getLastModifiedTime(configFile).toMillis() : -1;
			if (modified == configModified && modified != -1) return;
			Config next = Config.load(configFile);
			configModified = Files.getLastModifiedTime(configFile).toMillis();
			if (next.ready() && !next.equals(config)) {
				ChatLogMod.LOG.info("Sending chat to {}", URI.create(next.url()).getHost());
				nextAttempt = 0;
				backoff = 0;
			}
			config = next;
		} catch (Exception e) {
			ChatLogMod.LOG.error("Couldn't read {}: {}", configFile, e.getMessage());
		}
	}

	private void loadPending() {
		if (!Files.exists(pendingFile)) return;
		try {
			JsonArray saved = JsonParser.parseString(Files.readString(pendingFile, StandardCharsets.UTF_8)).getAsJsonArray();
			synchronized (queue) {
				for (int i = saved.size() - 1; i >= 0; i--) {
					JsonElement e = saved.get(i);
					if (e.isJsonObject()) queue.addFirst(e.getAsJsonObject());
				}
			}
			Files.delete(pendingFile);
			ChatLogMod.LOG.info("Loaded {} unsent chat messages from the last run", saved.size());
		} catch (Exception e) {
			ChatLogMod.LOG.error("Couldn't read {}: {}", pendingFile, e.getMessage());
		}
	}

	private void savePending() {
		JsonArray rest = new JsonArray();
		synchronized (queue) {
			queue.forEach(rest::add);
		}
		if (rest.isEmpty()) return;
		try {
			Files.writeString(pendingFile, rest.toString(), StandardCharsets.UTF_8);
			ChatLogMod.LOG.info("Saved {} unsent chat messages; they'll be sent after the next start", rest.size());
		} catch (Exception e) {
			ChatLogMod.LOG.error("Couldn't save unsent chat messages: {}", e.getMessage());
		}
	}

	private static String trim(String s) {
		return s == null ? "" : s.length() > 200 ? s.substring(0, 200) + "…" : s;
	}
}
