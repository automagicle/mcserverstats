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
import java.util.List;
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
	private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

	private volatile Config config = Config.EMPTY;
	private long configModified = -1;
	private ScheduledExecutorService exec;
	private long lastFlush;
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

	// Called from the server thread.
	void add(String kind, UUID uuid, String name, JsonArray display, String text) {
		if (text == null || text.isBlank()) return;
		JsonObject e = new JsonObject();
		e.addProperty("id", runId + "-" + seq.incrementAndGet());
		e.addProperty("ts", System.currentTimeMillis());
		e.addProperty("kind", kind);
		if (uuid != null) e.addProperty("uuid", uuid.toString());
		if (name != null) e.addProperty("name", name);
		if (display != null) e.add("display", display);
		e.addProperty("text", text);
		synchronized (queue) {
			queue.addLast(e);
			while (queue.size() > MAX_QUEUE) {
				queue.removeFirst();
				dropped++;
			}
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

		Config c = config;
		int status;
		String reply;
		try {
			HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(c.url()))
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
			status = res.statusCode();
			reply = res.body();
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			return false;
		} catch (Exception e) {
			fail("couldn't reach the dashboard (" + e.getClass().getSimpleName()
					+ (e.getMessage() != null ? ": " + e.getMessage() : "") + ")");
			return false;
		}

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
		fail(switch (status) {
			case 401 -> "the token doesn't match CHAT_INGEST_TOKEN on the Worker";
			case 503 -> "the Worker doesn't have a CHAT_INGEST_TOKEN secret yet";
			case 301, 302, 303, 307, 308, 403 -> "Cloudflare Access turned it away (HTTP " + status
					+ "); check access_client_id / access_client_secret and the Service Auth policy";
			case 404 -> "the url isn't right (HTTP 404); it should end in /api/ingest/chat";
			default -> "the dashboard answered HTTP " + status;
		});
		return false;
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
