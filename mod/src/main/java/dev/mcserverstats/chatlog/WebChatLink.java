package dev.mcserverstats.chatlog;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import java.util.regex.Pattern;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

// Chat sent from the dashboard: keeps one WebSocket open to the Worker (/api/ingest/link, next to
// the chat url) and hands each message it brings to the game. The Worker decides who may send
// (players whose login email is on the roster); this side checks the message is well formed,
// posts it in game chat on the server thread and answers whether that worked.
//
// Reconnects by itself with backoff, and pings every 30 seconds so a dead connection is noticed.
final class WebChatLink {
	// Answers "" if the message was shown, or why it wasn't. Called on a background thread.
	// name is null for an admin (shown with an [Admin] tag instead of a name).
	interface Handler {
		CompletableFuture<String> say(String name, String text);
	}

	private static final long PING_MS = 30_000;
	private static final long DEAD_MS = 75_000;
	private static final long MAX_BACKOFF_MS = 2 * 60_000;
	private static final long MISSING_BACKOFF_MS = 10 * 60_000; // an older dashboard without the endpoint
	private static final Pattern NAME = Pattern.compile("[A-Za-z0-9_]{1,32}");
	static final int MAX_TEXT = 256;

	private final Supplier<Config> config;
	private final String userAgent;
	private final Handler handler;
	private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

	private ScheduledExecutorService exec;
	private volatile WebSocket socket;
	private volatile long lastHeard;
	private volatile boolean connecting;
	private volatile long nextAttempt;
	private volatile long backoff;
	private volatile String lastWarning;
	private volatile Config connectedWith;

	WebChatLink(Supplier<Config> config, String userAgent, Handler handler) {
		this.config = config;
		this.userAgent = userAgent;
		this.handler = handler;
	}

	void start() {
		if (exec != null) return;
		exec = Executors.newSingleThreadScheduledExecutor(r -> {
			Thread t = new Thread(r, "mcstats-web-chat");
			t.setDaemon(true);
			return t;
		});
		exec.scheduleWithFixedDelay(this::tick, 2, 2, TimeUnit.SECONDS);
	}

	void stop() {
		if (exec == null) return;
		exec.shutdownNow();
		exec = null;
		close("server stopping");
	}

	// Every 2 seconds: connect if needed, ping, and notice dead or outdated connections.
	private void tick() {
		try {
			Config c = config.get();
			boolean wanted = c.ready() && c.webChat();
			WebSocket ws = socket;
			if (ws != null && (!wanted || !c.equals(connectedWith))) {
				close(wanted ? "settings changed" : "web chat turned off");
				ws = null;
			}
			long now = System.currentTimeMillis();
			if (ws != null) {
				if (now - lastHeard > DEAD_MS) {
					ChatLogMod.LOG.warn("Web chat connection went quiet; reconnecting");
					close("no answer");
				} else if (now - lastHeard > PING_MS) {
					ws.sendText("ping", true);
				}
				return;
			}
			if (!wanted || connecting || now < nextAttempt) return;
			connect(c);
		} catch (Throwable t) {
			ChatLogMod.LOG.error("Web chat failed unexpectedly", t);
		}
	}

	private void connect(Config c) {
		URI uri;
		try {
			uri = URI.create(c.url().replaceFirst("/chat/?$", "/link").replaceFirst("^http", "ws"));
		} catch (IllegalArgumentException e) {
			fail("the url isn't valid", MAX_BACKOFF_MS);
			return;
		}
		connecting = true;
		WebSocket.Builder b = http.newWebSocketBuilder()
				.connectTimeout(Duration.ofSeconds(15))
				.header("Authorization", "Bearer " + c.token())
				.header("User-Agent", userAgent);
		if (!c.accessClientId().isEmpty()) {
			b.header("CF-Access-Client-Id", c.accessClientId());
			b.header("CF-Access-Client-Secret", c.accessClientSecret());
		}
		b.buildAsync(uri, new Listener()).whenComplete((ws, err) -> {
			connecting = false;
			if (err != null) {
				Throwable cause = err.getCause() != null ? err.getCause() : err;
				if (cause instanceof WebSocketHandshakeException h) {
					int status = h.getResponse().statusCode();
					String type = h.getResponse().headers().firstValue("Content-Type").orElse("");
					if (status == 404 && type.contains("application/json")) {
						fail("the dashboard doesn't have web chat yet (update it with npm run deploy)", MISSING_BACKOFF_MS);
					} else {
						fail(Uploader.why(status, !type.contains("application/json")), 0);
					}
				} else {
					fail("couldn't reach the dashboard (" + cause.getClass().getSimpleName()
							+ (cause.getMessage() != null ? ": " + cause.getMessage() : "") + ")", 0);
				}
				return;
			}
			socket = ws;
			connectedWith = c;
			lastHeard = System.currentTimeMillis();
			backoff = 0;
			ChatLogMod.LOG.info("Web chat connected; messages sent from the dashboard will show in game");
			lastWarning = null;
		});
	}

	private void close(String why) {
		WebSocket ws = socket;
		socket = null;
		if (ws != null) {
			try {
				ws.sendClose(WebSocket.NORMAL_CLOSURE, why).orTimeout(3, TimeUnit.SECONDS);
			} catch (Exception ignored) { }
			ws.abort();
		}
	}

	private void fail(String why, long wait) {
		backoff = wait > 0 ? wait : Math.min(MAX_BACKOFF_MS, Math.max(5_000, backoff * 2));
		nextAttempt = System.currentTimeMillis() + backoff;
		if (!why.equals(lastWarning)) {
			ChatLogMod.LOG.warn("Web chat isn't connected: {}. Retrying in {}s", why, backoff / 1000);
			lastWarning = why;
		}
	}

	private void dropped(WebSocket ws, String why) {
		if (socket != ws) return; // already replaced or closed on purpose
		socket = null;
		ChatLogMod.LOG.info("Web chat disconnected ({}); reconnecting", why);
		nextAttempt = System.currentTimeMillis() + 3_000;
	}

	private void handle(WebSocket ws, String message) {
		if (message.equals("pong")) return;
		JsonObject m;
		try {
			m = JsonParser.parseString(message).getAsJsonObject();
		} catch (Exception e) {
			return;
		}
		if (!m.has("type") || !m.get("type").getAsString().equals("say") || !m.has("id")) return;
		String id = m.get("id").getAsString();
		boolean admin = m.has("admin") && m.get("admin").getAsBoolean();
		String name = admin ? null : m.has("name") ? m.get("name").getAsString() : "";
		String text = m.has("text") ? clean(m.get("text").getAsString()) : "";
		if ((!admin && !NAME.matcher(name).matches()) || text.isEmpty()) {
			ack(ws, id, "bad message");
			return;
		}
		handler.say(name, text)
				.completeOnTimeout("the server is busy", 4, TimeUnit.SECONDS)
				.whenComplete((error, err) -> ack(ws, id, err != null ? "the server couldn't show it" : error));
	}

	private static void ack(WebSocket ws, String id, String error) {
		JsonObject a = new JsonObject();
		a.addProperty("type", "ack");
		a.addProperty("id", id);
		a.addProperty("ok", error == null || error.isEmpty());
		if (error != null && !error.isEmpty()) a.addProperty("error", error);
		try {
			ws.sendText(a.toString(), true);
		} catch (Exception e) {
			ChatLogMod.LOG.debug("Couldn't answer a web chat message", e);
		}
	}

	// One line of plain text: no control characters or § formatting codes.
	static String clean(String s) {
		String t = s.replaceAll("[\\p{Cntrl}]+", " ").replaceAll("§.?", "").strip();
		return t.length() > MAX_TEXT ? t.substring(0, MAX_TEXT) : t;
	}

	private final class Listener implements WebSocket.Listener {
		private final StringBuilder parts = new StringBuilder();

		@Override
		public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
			lastHeard = System.currentTimeMillis();
			parts.append(data);
			if (last) {
				String message = parts.toString();
				parts.setLength(0);
				if (message.length() <= 8192) handle(ws, message);
			}
			ws.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onPong(WebSocket ws, java.nio.ByteBuffer message) {
			lastHeard = System.currentTimeMillis();
			ws.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onClose(WebSocket ws, int code, String reason) {
			dropped(ws, reason == null || reason.isEmpty() ? "code " + code : reason);
			return null;
		}

		@Override
		public void onError(WebSocket ws, Throwable error) {
			dropped(ws, error.getClass().getSimpleName());
		}
	}
}
