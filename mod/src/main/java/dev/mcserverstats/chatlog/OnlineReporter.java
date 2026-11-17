package dev.mcserverstats.chatlog;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

// Who's online, as the server itself knows it (everyone in the tab list), for the dashboard's player
// counts. The dashboard's own check goes through the server-list ping, which can leave players out
// (it shows at most a sample, and players who turned off "Allow Server Listings" appear as
// "Anonymous Player"); it adds in whoever this list has that the ping didn't.
// Looked at every second on the server thread; sent as soon as it changes, and every 20 seconds
// regardless, so the dashboard can tell the list is current (it stops trusting one older than 75 s).
final class OnlineReporter {
	private static final int CHECK_TICKS = 20;
	private static final long HEARTBEAT_MS = 20_000;

	private final Uploader uploader;
	private String last;
	private long lastAt;
	private int ticks;

	OnlineReporter(Uploader uploader) {
		this.uploader = uploader;
	}

	// Called at the end of every server tick.
	void tick(MinecraftServer server) {
		if (++ticks < CHECK_TICKS) return;
		ticks = 0;
		List<ServerPlayer> online = new ArrayList<>(server.getPlayerList().getPlayers());
		online.sort(Comparator.comparing(ServerPlayer::getUUID));
		JsonArray players = new JsonArray();
		for (ServerPlayer p : online) {
			JsonObject o = new JsonObject();
			o.addProperty("uuid", p.getUUID().toString());
			o.addProperty("name", p.getScoreboardName());
			players.add(o);
		}
		String now = players.toString();
		long t = System.currentTimeMillis();
		boolean changed = !now.equals(last);
		if (!changed && t - lastAt < HEARTBEAT_MS) return;
		last = now;
		lastAt = t;
		JsonObject report = new JsonObject();
		report.add("players", players);
		uploader.setOnline(report);
		if (changed) uploader.flushSoon();
	}

	// The server is shutting down: nobody's on any more (sent on the way out, best effort).
	void stopping(MinecraftServer server) {
		JsonObject report = new JsonObject();
		report.add("players", new JsonArray());
		report.addProperty("stopping", true);
		uploader.setOnline(report);
		last = null;
	}
}
