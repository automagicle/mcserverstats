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
import net.minecraft.commands.CommandSourceStack;
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
// carrying (GearReporter) and their advancements (AdvancementReporter), for their dashboard page,
// shows chat sent from the dashboard in game (WebChatLink), and reports who's online (OnlineReporter).
public final class ChatLogMod implements DedicatedServerModInitializer {
	static final Logger LOG = LoggerFactory.getLogger("mcstats-chat");

	// Player names (Java, or Bedrock through Floodgate's "." prefix); mobs' insertions are UUIDs.
	private static final Pattern PLAYER_NAME = Pattern.compile("[A-Za-z0-9_.]{1,20}");

	private Uploader uploader;
	private WebChatLink link;
	private volatile MinecraftServer server;
	private static volatile MinecraftServer current; // the same, for the static helpers
	private static volatile ChatLogMod instance; // for CommandsMixin
	// "msg Name text", "tell Name text" or "w Name text", as the command arrives (no slash)
	private static final Pattern WHISPER_COMMAND = Pattern.compile("(?i)/?(?:msg|tell|w)\\s+([A-Za-z0-9_.]{1,20})\\s+(\\S.*)", Pattern.DOTALL);
	// set while this mod posts a web message itself, so the system-message logger doesn't log it again
	private boolean postingWeb;

	@Override
	public void onInitializeServer() {
		Path dir = FabricLoader.getInstance().getConfigDir();
		String version = FabricLoader.getInstance().getModContainer("mcstats_chat")
				.map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("dev");
		uploader = new Uploader(dir.resolve("mcstats-chat.properties"), dir.resolve("mcstats-chat-pending.json"), version);
		link = new WebChatLink(uploader::config, uploader::linkDownFor, "mcstats-chat/" + version, new WebChatLink.Handler() {
			@Override
			public CompletableFuture<String> say(String name, String text, java.util.function.BooleanSupplier claim) {
				return webMessage(name, text, claim);
			}

			@Override
			public CompletableFuture<String> whisper(String from, String to, String text, java.util.function.BooleanSupplier claim) {
				return webWhisper(from, to, text, claim);
			}
		});
		instance = this;

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

		OnlineReporter online = new OnlineReporter(uploader);
		ServerTickEvents.END_SERVER_TICK.register(online::tick);
		ServerLifecycleEvents.SERVER_STOPPING.register(online::stopping);

		GearReporter gear = new GearReporter(uploader);
		ServerTickEvents.END_SERVER_TICK.register(gear::tick);

		AdvancementReporter advancements = new AdvancementReporter(uploader);
		ServerLifecycleEvents.SERVER_STARTED.register(advancements::sendTree);
		ServerLifecycleEvents.END_DATA_PACK_RELOAD.register((server, resources, success) -> {
			if (success) advancements.sendTree(server);
		});
		ServerTickEvents.END_SERVER_TICK.register(advancements::tick);

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
			if (overlay) return;
			broadcastThisTick.add(message.getString()); // so playerMessage doesn't log it a second time
			if (!postingWeb && uploader.systemMessages()) systemMessage(server, message);
		});
		ServerTickEvents.END_SERVER_TICK.register(this::logSentToEveryone);
	}

	// A message sent from the dashboard by a roster player: shown to everyone as "[Web] <name> text",
	// the name in their team's colors, and logged as their chat (marked as from the web). An admin's
	// (name null) shows as "[Web] [Admin] text" with the tag in yellow. Runs on the server thread;
	// the answer is "" when it was shown.
	// `claim` says whether it's still wanted: false once the wait for the server thread ran out and the
	// sender was told it wasn't shown, so it mustn't turn up afterwards.
	private CompletableFuture<String> webMessage(String name, String text, java.util.function.BooleanSupplier claim) {
		MinecraftServer s = server;
		if (s == null) return CompletableFuture.completedFuture("the server is starting or stopping");
		CompletableFuture<String> done = new CompletableFuture<>();
		s.execute(() -> {
			if (!claim.getAsBoolean()) return;
			try {
				Component who;
				MutableComponent line = Component.empty().append(Component.literal("[Web] ").withStyle(ChatFormatting.GRAY));
				if (name == null) {
					who = Component.literal("[Admin]").withStyle(ChatFormatting.YELLOW);
					line.append(who).append(" ").append(Component.literal(text));
				} else {
					who = PlayerTeam.formatNameForTeam(teamOf(s, name), Component.literal(name).withStyle(st -> st.withInsertion(name)));
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

	// A whisper typed on the dashboard, shown only to `to` (if they're on) the way the game shows one,
	// with a [Web] tag: "[Web] Name whispers to you: text", the name in their team's colors (an admin's,
	// from null, as a yellow [Admin]). Never logged. Runs on the server thread; "" when it was shown.
	private CompletableFuture<String> webWhisper(String from, String to, String text, java.util.function.BooleanSupplier claim) {
		MinecraftServer s = server;
		if (s == null) return CompletableFuture.completedFuture("the server is starting or stopping");
		CompletableFuture<String> done = new CompletableFuture<>();
		s.execute(() -> {
			if (!claim.getAsBoolean()) return;
			try {
				ServerPlayer target = s.getPlayerList().getPlayerByName(to);
				if (target == null) {
					done.complete("No player was found");
					return;
				}
				Component line = webTag().append(Component.translatable("commands.message.display.incoming",
						from == null ? Component.literal("[Admin]").withStyle(ChatFormatting.YELLOW) : teamName(s, from), Component.literal(text))
						.withStyle(ChatFormatting.GRAY, ChatFormatting.ITALIC));
				unlogged(() -> target.sendSystemMessage(line));
				done.complete("");
			} catch (RuntimeException e) {
				LOG.error("Couldn't show a web whisper", e);
				done.complete("the server couldn't show it");
			}
		});
		return done;
	}

	// Sends something of this mod's own (a whisper, say) without the chat log picking it up.
	private void unlogged(Runnable send) {
		boolean was = postingWeb;
		postingWeb = true;
		try {
			send.run();
		} finally {
			postingWeb = was;
		}
	}

	private static MutableComponent webTag() {
		return Component.empty().append(Component.literal("[Web] ").withStyle(ChatFormatting.GRAY));
	}

	private static MutableComponent teamName(MinecraftServer s, String name) {
		return PlayerTeam.formatNameForTeam(teamOf(s, name), Component.literal(name).withStyle(st -> st.withInsertion(name)));
	}

	// Roster players with the dashboard open who aren't in game: who /msg can suggest, besides the game's own.
	static java.util.List<String> webOnlyPlayers() {
		ChatLogMod mod = instance;
		MinecraftServer s = current;
		if (mod == null || s == null) return java.util.List.of();
		java.util.List<String> out = new java.util.ArrayList<>();
		for (String name : mod.link.webPlayers()) if (s.getPlayerList().getPlayerByName(name) == null) out.add(name);
		out.sort(String.CASE_INSENSITIVE_ORDER);
		return out;
	}

	// Called by CommandsMixin before any command runs: a whisper (/msg, /tell, /w) to a player who isn't
	// in game but has the dashboard open goes to them there instead of failing with "No player was
	// found". The sender sees it the way the game shows one sent, with a [Web] tag. True if it was
	// handled (the command doesn't run); anything else, including whispers between players in game,
	// runs as usual and isn't recorded.
	public static boolean whisperToWeb(CommandSourceStack source, String command) {
		ChatLogMod mod = instance;
		MinecraftServer s = current;
		if (mod == null || s == null || command == null) return false;
		var m = WHISPER_COMMAND.matcher(command.strip());
		if (!m.matches()) return false;
		String to = m.group(1);
		if (s.getPlayerList().getPlayerByName(to) != null) return false; // in game: the game's own whisper
		String webName = mod.link.webPlayer(to);
		if (webName == null) return false;
		ServerPlayer player = source.getPlayer();
		String from = player != null ? player.getScoreboardName() : null;
		if (from == null) return false; // the console and command blocks whisper as usual
		String text = WebChatLink.clean(m.group(2));
		if (text.isEmpty()) return false;
		boolean sent = mod.link.whisperUp(from, webName, text, why -> s.execute(() -> {
			ServerPlayer p = s.getPlayerList().getPlayer(player.getUUID());
			if (p != null) mod.unlogged(() -> p.sendSystemMessage(webTag().append(Component.literal("Couldn't reach " + webName + " on the website: " + why).withStyle(ChatFormatting.RED))));
		}));
		if (!sent) return false;
		mod.unlogged(() -> source.sendSystemMessage(webTag().append(Component.translatable("commands.message.display.outgoing", teamName(s, webName), Component.literal(text))
				.withStyle(ChatFormatting.GRAY, ChatFormatting.ITALIC))));
		return true;
	}

	// System messages sent to players one at a time this tick: text -> who got it. Some mods announce
	// things to everyone that way (a combat logger's location, say) rather than as a broadcast.
	private static final class Sent {
		final Component message;
		final java.util.Set<UUID> to = new java.util.HashSet<>();
		boolean onlyOneOnline; // sent while one player was on: public unless it answers something they did
		boolean answer;

		Sent(Component message) {
			this.message = message;
		}
	}

	private final java.util.Map<String, Sent> sentThisTick = new java.util.LinkedHashMap<>();
	private final java.util.Set<String> broadcastThisTick = new java.util.HashSet<>();

	// Called by ServerPlayerMixin for every system message a player is sent (on the server thread).
	public static void playerMessage(ServerPlayer player, Component message, boolean overlay) {
		ChatLogMod mod = instance;
		MinecraftServer s = current;
		if (mod == null || s == null || overlay || mod.postingWeb || !s.isSameThread() || !mod.uploader.systemMessages()) return;
		if (mod.sentThisTick.size() >= 200) return;
		String text = message.getString();
		if (text.isBlank() || text.length() > 1000) return;
		Sent sent = mod.sentThisTick.get(text);
		if (sent == null) {
			sent = new Sent(message);
			mod.sentThisTick.put(text, sent);
			// With one player on, "sent to everyone" and "sent to them" look the same. It counts as an
			// answer to them (not logged) when it comes out of a command, or out of handling something
			// they did other than a player leaving.
			if (s.getPlayerList().getPlayerCount() <= 1) {
				sent.onlyOneOnline = true;
				sent.answer = StackWalker.getInstance().walk(frames -> frames.limit(80).anyMatch(f -> {
					String c = f.getClassName();
					return c.startsWith("com.mojang.brigadier.")
							|| (c.endsWith("ServerGamePacketListenerImpl") && !f.getMethodName().toLowerCase().contains("disconnect"));
				}));
			}
		}
		sent.to.add(player.getUUID());
	}

	// At the end of each tick: whatever was sent to every player on (and wasn't a broadcast, which is
	// logged already) goes in the chat log as a server message.
	private void logSentToEveryone(MinecraftServer server) {
		if (sentThisTick.isEmpty()) {
			broadcastThisTick.clear();
			return;
		}
		try {
			java.util.List<ServerPlayer> online = server.getPlayerList().getPlayers();
			for (java.util.Map.Entry<String, Sent> e : sentThisTick.entrySet()) {
				Sent sent = e.getValue();
				if (broadcastThisTick.contains(e.getKey())) continue;
				boolean everyone = sent.to.size() >= 2 && online.stream().allMatch(p -> sent.to.contains(p.getUUID()));
				if (everyone || (sent.onlyOneOnline && !sent.answer)) systemMessage(server, sent.message);
			}
		} finally {
			sentThisTick.clear();
			broadcastThisTick.clear();
		}
	}

	// A player's team by name, whatever capitals the name was given in (teams hold names exactly).
	private static PlayerTeam teamOf(MinecraftServer s, String name) {
		PlayerTeam team = s.getScoreboard().getPlayersTeam(name);
		if (team != null) return team;
		for (PlayerTeam t : s.getScoreboard().getPlayerTeams()) {
			for (String member : t.getPlayers()) if (member.equalsIgnoreCase(name)) return t;
		}
		return null;
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
			// exactly that name first: the game's own lookup ignores case, and on an offline-mode server
			// "Name" and "name" are different accounts (both can be on, e.g. while one reconnects)
			ServerPlayer player = null;
			for (ServerPlayer p : server.getPlayerList().getPlayers()) {
				if (p.getScoreboardName().equals(name)) { player = p; break; }
			}
			if (player == null) player = server.getPlayerList().getPlayerByName(name);
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
			return tooltip(show.item().create());
		} catch (RuntimeException e) {
			LOG.debug("Couldn't read an item's tooltip", e);
			return null;
		}
	}

	// The same for an item in hand (GearReporter: the weapons and tools a player carries).
	static JsonArray tooltip(ItemStack stack) {
		try {
			MinecraftServer s = current;
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
