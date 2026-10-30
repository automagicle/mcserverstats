package dev.mcserverstats.chatlog;

import java.nio.file.Path;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import net.fabricmc.api.DedicatedServerModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.network.chat.ChatType;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.Style;
import net.minecraft.network.chat.TextColor;
import net.minecraft.network.chat.contents.TranslatableContents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

// Records public chat (plus joins, leaves, deaths and advancements) and hands it to the
// uploader, which sends it to the dashboard in the background. Private messages
// (/msg, /tell, /teammsg) are never recorded.
public final class ChatLogMod implements DedicatedServerModInitializer {
	static final Logger LOG = LoggerFactory.getLogger("mcstats-chat");

	// Player names (Java, or Bedrock through Floodgate's "." prefix); mobs' insertions are UUIDs.
	private static final Pattern PLAYER_NAME = Pattern.compile("[A-Za-z0-9_.]{1,20}");

	private Uploader uploader;

	@Override
	public void onInitializeServer() {
		Path dir = FabricLoader.getInstance().getConfigDir();
		String version = FabricLoader.getInstance().getModContainer("mcstats_chat")
				.map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("dev");
		uploader = new Uploader(dir.resolve("mcstats-chat.properties"), dir.resolve("mcstats-chat-pending.json"), version);

		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			uploader.start();
			uploader.add("server", null, null, null, null, "Server started");
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> uploader.add("server", null, null, null, null, "Server stopped"));
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> uploader.stop());

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
			if (!overlay && uploader.systemMessages()) systemMessage(server, message);
		});
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
