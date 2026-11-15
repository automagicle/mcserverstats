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
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.network.chat.Style;
import net.minecraft.network.chat.TextColor;
import net.minecraft.network.chat.contents.TranslatableContents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.TooltipFlag;
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
	private static volatile MinecraftServer current; // the same, for the static helpers
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
			current = server;
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
			current = null;
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
	// the name in their team's colors, and logged as their chat (marked as from the web). An admin's
	// (name null) shows as "[Web] [Admin] text" with the tag in yellow. Runs on the server thread;
	// the answer is "" when it was shown.
	private CompletableFuture<String> webMessage(String name, String text) {
		MinecraftServer s = server;
		if (s == null) return CompletableFuture.completedFuture("the server is starting or stopping");
		CompletableFuture<String> done = new CompletableFuture<>();
		s.execute(() -> {
			try {
				Component who;
				MutableComponent line = Component.empty().append(Component.literal("[Web] ").withStyle(ChatFormatting.GRAY));
				if (name == null) {
					who = Component.literal("[Admin]").withStyle(ChatFormatting.YELLOW);
					line.append(who).append(" ").append(Component.literal(text));
				} else {
					PlayerTeam team = s.getScoreboard().getPlayersTeam(name);
					who = PlayerTeam.formatNameForTeam(team, Component.literal(name).withStyle(st -> st.withInsertion(name)));
					line.append(Component.translatable("chat.type.text", who, Component.literal(text)));
				}
				postingWeb = true;
				try {
					s.getPlayerList().broadcastSystemMessage(line, false);
				} finally {
					postingWeb = false;
				}
				if (name == null) {
					uploader.add("chat", null, null, styled(who, 8), null, text, "admin");
				} else {
					ServerPlayer online = s.getPlayerList().getPlayerByName(name);
					uploader.add("chat", online == null ? null : online.getUUID(), name, styled(who, 8), null, text, "web");
				}
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
		JsonObject death = null;
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
			if (kind.equals("death")) death = deathDetails(key, args);
		}
		UUID uuid = null;
		if (name != null) {
			ServerPlayer player = server.getPlayerList().getPlayerByName(name);
			if (player != null) uuid = player.getUUID();
		}
		// The whole message too, so other names in it (a killer) and item names keep their colors.
		uploader.add(kind, uuid, name, display, kind.equals("system") ? null : styled(message, 32), message.getString(), null, death);
	}

	// How a death happened, from the death message itself, for the dashboard's combat page:
	// { cause, killer?, killer_uuid?, mob?, weapon? }. cause is the message's translation key
	// (death.attack.player.item, death.fell.accident.generic, …). The second argument of a death
	// message is who the game credits with it: a player (killer, killer_uuid) or another creature
	// (mob, its entity type, like "zombie"). The third is the named item it was done with.
	private static JsonObject deathDetails(String key, Object[] args) {
		JsonObject d = new JsonObject();
		d.addProperty("cause", key);
		if (args.length > 1 && args[1] instanceof Component by) {
			HoverEvent.EntityTooltipInfo info = entityOf(by);
			if (info != null && info.type == EntityTypes.PLAYER) {
				d.addProperty("killer", plainName(by));
				d.addProperty("killer_uuid", info.uuid.toString());
			} else if (info != null) {
				String type = BuiltInRegistries.ENTITY_TYPE.getKey(info.type).toString();
				d.addProperty("mob", type.startsWith("minecraft:") ? type.substring(10) : type);
			}
		}
		if (args.length > 2 && args[2] instanceof Component item) {
			String weapon = item.getString().replaceAll("^\\[|\\]$", "");
			if (!weapon.isBlank()) d.addProperty("weapon", weapon.length() > 60 ? weapon.substring(0, 60) : weapon);
		}
		return d;
	}

	// The entity a name in a message stands for (names carry it as their hover text).
	private static HoverEvent.EntityTooltipInfo entityOf(Component c) {
		return c.visit((style, text) -> style.getHoverEvent() instanceof HoverEvent.ShowEntity show
				? Optional.of(show.entity()) : Optional.<HoverEvent.EntityTooltipInfo>empty(), Style.EMPTY).orElse(null);
	}

	// Text as chat shows it (team prefixes, colors), as [{ t: text, c: "#rrggbb", p: player }] pieces.
	// p marks pieces of a player's name (its click-to-insert text), so the dashboard can link it.
	static JsonArray styled(Component c, int max) {
		JsonArray out = new JsonArray();
		HoverEvent.ShowItem[] seen = new HoverEvent.ShowItem[1];
		c.visit((style, text) -> {
			if (!text.isEmpty() && out.size() < max) {
				JsonObject piece = new JsonObject();
				piece.addProperty("t", text);
				TextColor color = style.getColor();
				if (color != null) piece.addProperty("c", String.format("#%06x", color.getValue() & 0xFFFFFF));
				String who = style.getInsertion();
				if (who != null && PLAYER_NAME.matcher(who).matches()) piece.addProperty("p", who);
				// An item's name (the weapon in a death message): marked, and the first piece of it
				// carries what hovering over it shows in game.
				if (style.getHoverEvent() instanceof HoverEvent.ShowItem show) {
					piece.addProperty("w", true);
					if (seen[0] != show) {
						seen[0] = show;
						JsonArray lines = tooltip(show);
						if (lines != null) piece.add("i", lines);
					}
				}
				out.add(piece);
			}
			return Optional.empty();
		}, Style.EMPTY);
		return out.isEmpty() ? null : out;
	}

	// An item's tooltip as the game shows it (name, enchantments, attributes, lore): a list of
	// lines, each a list of { t, c?, i? (italic) } pieces. An empty list is a blank line.
	private static JsonArray tooltip(HoverEvent.ShowItem show) {
		try {
			MinecraftServer s = current;
			ItemStack stack = show.item().create();
			Item.TooltipContext context = s == null ? Item.TooltipContext.EMPTY : Item.TooltipContext.of(s.registryAccess());
			JsonArray lines = new JsonArray();
			for (Component line : stack.getTooltipLines(context, null, TooltipFlag.NORMAL)) {
				if (lines.size() >= 24) break;
				JsonArray pieces = new JsonArray();
				line.visit((style, text) -> {
					if (!text.isEmpty() && pieces.size() < 8) {
						JsonObject piece = new JsonObject();
						piece.addProperty("t", text.length() > 120 ? text.substring(0, 120) : text);
						TextColor color = style.getColor();
						if (color != null) piece.addProperty("c", String.format("#%06x", color.getValue() & 0xFFFFFF));
						if (style.isItalic()) piece.addProperty("i", true);
						pieces.add(piece);
					}
					return Optional.empty();
				}, Style.EMPTY);
				lines.add(pieces);
			}
			return lines.isEmpty() ? null : lines;
		} catch (RuntimeException e) {
			LOG.debug("Couldn't read an item's tooltip", e);
			return null;
		}
	}

	// A player's display name can carry a team prefix; its click-to-insert text is the bare name.
	private static String plainName(Component c) {
		String insertion = c.getStyle().getInsertion();
		return insertion != null && !insertion.isEmpty() ? insertion : c.getString();
	}
}
