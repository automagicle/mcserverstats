package dev.mcserverstats.chatlog;

import java.nio.file.Path;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import net.fabricmc.api.DedicatedServerModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.ChatType;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.Style;
import net.minecraft.network.chat.TextColor;
import net.minecraft.network.chat.contents.TranslatableContents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.scores.PlayerTeam;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

// Records public chat (plus joins, leaves, deaths and advancements) and hands it to the
// uploader, which sends it to the dashboard in the background. Private messages
// (/msg, /tell, /teammsg) are never recorded. Also reports what each player is wearing and
// carrying (GearReporter), for the 3D model on their dashboard page, and shows chat sent from the
// dashboard in game (WebChatLink).
public final class ChatLogMod implements DedicatedServerModInitializer {
	static final Logger LOG = LoggerFactory.getLogger("mcstats-chat");

	// Player names (Java, or Bedrock through Floodgate's "." prefix); mobs' insertions are UUIDs.
	private static final Pattern PLAYER_NAME = Pattern.compile("[A-Za-z0-9_.]{1,20}");

	private Uploader uploader;
	private WebChatLink link;
	private volatile MinecraftServer server;
	// set while this mod posts a web message itself, so the system-message logger doesn't log it again
	private boolean postingWeb;

	@Override
	public void onInitializeServer() {
		Path dir = FabricLoader.getInstance().getConfigDir();
		String version = FabricLoader.getInstance().getModContainer("mcstats_chat")
				.map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("dev");
		uploader = new Uploader(dir.resolve("mcstats-chat.properties"), dir.resolve("mcstats-chat-pending.json"), version);
		link = new WebChatLink(uploader::config, "mcstats-chat/" + version, this::webMessage);

		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			this.server = server;
			uploader.start();
			uploader.add("server", null, null, null, null, "Server started");
			link.start();
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			link.stop();
			uploader.add("server", null, null, null, null, "Server stopped");
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> {
			uploader.stop();
			this.server = null;
		});

		GearReporter gear = new GearReporter(uploader);
		ServerTickEvents.END_SERVER_TICK.register(gear::tick);

		ServerMessageEvents.CHAT_MESSAGE.register((message, sender, params) ->
				uploader.add("chat", sender.getUUID(), sender.getScoreboardName(), styled(params.name(), 8), null,
						message.decoratedContent().getString()));

		// /say and /me. Other command messages (like /teammsg) only go to some players, so they're skipped.
		ServerMessageEvents.COMMAND_MESSAGE.register((message, source, params) -> {
			String kind = params.chatType().is(ChatType.EMOTE_COMMAND) ? "emote"
					: params.chatType().is(ChatType.SAY_COMMAND) ? "say" : null;
			if (kind == null) return;
			ServerPlayer player = source.getPlayer();
			uploader.add(kind, player == null ? null : player.getUUID(), source.getTextName(), styled(params.name(), 8), null,
					message.decoratedContent().getString());
		});

		ServerMessageEvents.GAME_MESSAGE.register((server, message, overlay) -> {
			if (!overlay && !postingWeb && uploader.systemMessages()) systemMessage(server, message);
		});
	}

	// A message sent from the dashboard by a roster player: shown to everyone as "[Web] <name> text",
	// the name in their team's colors, and logged as their chat (marked as from the web). Runs on the
	// server thread; the answer is "" when it was shown.
	private CompletableFuture<String> webMessage(String name, String text) {
		MinecraftServer s = server;
		if (s == null) return CompletableFuture.completedFuture("the server is starting or stopping");
		CompletableFuture<String> done = new CompletableFuture<>();
		s.execute(() -> {
			try {
				PlayerTeam team = s.getScoreboard().getPlayersTeam(name);
				Component who = PlayerTeam.formatNameForTeam(team, Component.literal(name).withStyle(st -> st.withInsertion(name)));
				Component line = Component.empty()
						.append(Component.literal("[Web] ").withStyle(ChatFormatting.GRAY))
						.append(Component.translatable("chat.type.text", who, Component.literal(text)));
				postingWeb = true;
				try {
					s.getPlayerList().broadcastSystemMessage(line, false);
				} finally {
					postingWeb = false;
				}
				ServerPlayer online = s.getPlayerList().getPlayerByName(name);
				uploader.add("chat", online == null ? null : online.getUUID(), name, styled(who, 8), null, text, "web");
				uploader.flushSoon();
				done.complete("");
			} catch (RuntimeException e) {
				LOG.error("Couldn't show a web chat message", e);
				done.complete("the server couldn't show it");
			}
		});
		return done;
	}

	// Broadcast server messages, sorted by their translation key. The first argument of a
	// join/leave/death/advancement message is the player it's about.
	private void systemMessage(MinecraftServer server, Component message) {
		String kind = "system";
		String name = null;
		JsonArray display = null;
		if (message.getContents() instanceof TranslatableContents tc) {
			String key = tc.getKey();
			if (key.startsWith("multiplayer.player.joined")) kind = "join";
			else if (key.equals("multiplayer.player.left")) kind = "leave";
			else if (key.startsWith("death.")) kind = "death";
			else if (key.startsWith("chat.type.advancement.")) kind = "advancement";
			Object[] args = tc.getArgs();
			if (!kind.equals("system") && args.length > 0 && args[0] instanceof Component who) {
				name = plainName(who);
				display = styled(who, 8);
			}
		}
		UUID uuid = null;
		if (name != null) {
			ServerPlayer player = server.getPlayerList().getPlayerByName(name);
			if (player != null) uuid = player.getUUID();
		}
		// The whole message too, so other names in it (a killer) and item names keep their colors.
		uploader.add(kind, uuid, name, display, kind.equals("system") ? null : styled(message, 32), message.getString());
	}

	// Text as chat shows it (team prefixes, colors), as [{ t: text, c: "#rrggbb", p: player }] pieces.
	// p marks pieces of a player's name (its click-to-insert text), so the dashboard can link it.
	static JsonArray styled(Component c, int max) {
		JsonArray out = new JsonArray();
		c.visit((style, text) -> {
			if (!text.isEmpty() && out.size() < max) {
				JsonObject piece = new JsonObject();
				piece.addProperty("t", text);
				TextColor color = style.getColor();
				if (color != null) piece.addProperty("c", String.format("#%06x", color.getValue() & 0xFFFFFF));
				String who = style.getInsertion();
				if (who != null && PLAYER_NAME.matcher(who).matches()) piece.addProperty("p", who);
				out.add(piece);
			}
			return Optional.empty();
		}, Style.EMPTY);
		return out.isEmpty() ? null : out;
	}

	// A player's display name can carry a team prefix; its click-to-insert text is the bare name.
	private static String plainName(Component c) {
		String insertion = c.getStyle().getInsertion();
		return insertion != null && !insertion.isEmpty() ? insertion : c.getString();
	}
}
