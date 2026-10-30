package dev.mcserverstats.chatlog;

import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

// config/mcstats-chat.properties. Created with blank values on first start; edits are
// picked up within a few seconds, without a restart.
record Config(String url, String token, String accessClientId, String accessClientSecret, boolean systemMessages) {
	static final Config EMPTY = new Config("", "", "", "", true);

	private static final String TEMPLATE = """
			# mcstats chat log: sends this server's public chat to your mcstats dashboard.
			# Saved changes are picked up within a few seconds; no restart needed.

			# Your dashboard's address followed by /api/ingest/chat,
			# e.g. https://mcstats.example.workers.dev/api/ingest/chat
			url=

			# The same value as the CHAT_INGEST_TOKEN secret on the Worker.
			token=

			# Cloudflare Access service token, so the request gets past the login page
			# (Zero Trust > Access > Service credentials > Service tokens).
			access_client_id=
			access_client_secret=

			# Also log joins, leaves, deaths and advancements.
			system_messages=true
			""";

	boolean ready() {
		return !url.isEmpty() && !token.isEmpty();
	}

	static Config load(Path file) throws IOException {
		if (!Files.exists(file)) {
			Files.createDirectories(file.getParent());
			Files.writeString(file, TEMPLATE, StandardCharsets.UTF_8);
			ChatLogMod.LOG.warn("Created {}. Fill in url and token to start sending chat.", file);
		}
		Properties p = new Properties();
		try (Reader r = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
			p.load(r);
		}
		return new Config(
				get(p, "url"), get(p, "token"), get(p, "access_client_id"), get(p, "access_client_secret"),
				!get(p, "system_messages").equalsIgnoreCase("false"));
	}

	private static String get(Properties p, String key) {
		return p.getProperty(key, "").trim();
	}
}
