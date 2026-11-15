package dev.mcserverstats.chatlog;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import net.minecraft.advancements.Advancement;
import net.minecraft.advancements.AdvancementHolder;
import net.minecraft.advancements.AdvancementProgress;
import net.minecraft.advancements.CriterionProgress;
import net.minecraft.advancements.DisplayInfo;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.PlayerAdvancements;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.ItemStackTemplate;

// Advancements, for the tree on each player's dashboard page.
//
// The tree itself (every advancement the advancements screen can show: its title, description,
// icon, frame, parent and where the game places it on the screen) is sent when the server starts
// and again after a data pack reload, so advancements added by data packs are included.
//
// Each online player's progress (which they have and when they got each, and for the ones they're
// partway through, which criteria are done) is checked every few seconds on the server thread and
// sent only when it changed, at most twice a minute per player.
final class AdvancementReporter {
	private static final int CHECK_TICKS = 15 * 20;
	private static final long MIN_GAP_MS = 30_000;
	private static final int MAX_CRITERIA = 120;

	private final Uploader uploader;
	private final Map<UUID, String> lastSent = new HashMap<>();
	private final Map<UUID, Long> lastSentAt = new HashMap<>();
	private int ticks;

	AdvancementReporter(Uploader uploader) {
		this.uploader = uploader;
	}

	// The whole tree, as { ts, list: [{ id, parent?, title, desc, icon: { id, model?, glint? },
	// frame (task, goal or challenge), x, y, hidden?, bg? (a tab's background texture), of }] }.
	// x and y are the game's own layout: columns and rows, as the advancements screen draws them.
	void sendTree(MinecraftServer server) {
		try {
			JsonArray list = new JsonArray();
			for (AdvancementHolder holder : server.getAdvancements().getAllAdvancements()) {
				Advancement a = holder.value();
				DisplayInfo d = a.display().orElse(null);
				if (d == null) continue; // recipe unlocks and other advancements the screen never shows
				JsonObject o = new JsonObject();
				o.addProperty("id", short_(holder.id().toString()));
				a.parent().ifPresent(p -> o.addProperty("parent", short_(p.toString())));
				o.addProperty("title", clip(d.getTitle().getString(), 80));
				o.addProperty("desc", clip(d.getDescription().getString(), 300));
				o.add("icon", icon(d.getIcon()));
				o.addProperty("frame", d.getType().getSerializedName());
				o.addProperty("x", d.getX());
				o.addProperty("y", d.getY());
				if (d.isHidden()) o.addProperty("hidden", true);
				d.getBackground().ifPresent(bg -> o.addProperty("bg", short_(bg.id().toString())));
				o.addProperty("of", a.requirements().size());
				list.add(o);
			}
			JsonObject tree = new JsonObject();
			tree.addProperty("ts", System.currentTimeMillis());
			tree.add("list", list);
			uploader.setAdvancementTree(tree);
			lastSent.clear(); // a reload can change what counts; report everyone again
		} catch (RuntimeException e) {
			ChatLogMod.LOG.warn("Couldn't read the advancement tree", e);
		}
	}

	// Called at the end of every server tick.
	void tick(MinecraftServer server) {
		if (++ticks < CHECK_TICKS) return;
		ticks = 0;
		long now = System.currentTimeMillis();
		List<AdvancementHolder> shown = null;
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			UUID id = player.getUUID();
			if (now - lastSentAt.getOrDefault(id, 0L) < MIN_GAP_MS) continue;
			if (shown == null) {
				shown = server.getAdvancements().getAllAdvancements().stream()
						.filter(h -> h.value().display().isPresent()).toList();
			}
			JsonObject report;
			try {
				report = report(player, shown);
			} catch (RuntimeException e) {
				ChatLogMod.LOG.debug("Couldn't read {}'s advancements", player.getScoreboardName(), e);
				continue;
			}
			String json = report.toString();
			if (json.equals(lastSent.get(id))) continue;
			lastSent.put(id, json);
			lastSentAt.put(id, now);
			report.addProperty("uuid", id.toString());
			report.addProperty("name", player.getScoreboardName());
			report.addProperty("ts", now);
			uploader.addAdvancements(id, report);
		}
	}

	// { done: { id: unix seconds it was completed }, part: { id: { n, of, got: [criteria done] } } }
	// n of `of` is how far along it is, counted the way the game's progress bar counts it.
	private static JsonObject report(ServerPlayer player, List<AdvancementHolder> shown) {
		PlayerAdvancements mine = player.getAdvancements();
		JsonObject done = new JsonObject();
		JsonObject part = new JsonObject();
		for (AdvancementHolder holder : shown) {
			AdvancementProgress p = mine.getOrStartProgress(holder);
			if (!p.hasProgress()) continue;
			String id = short_(holder.id().toString());
			Instant last = null;
			JsonArray got = new JsonArray();
			for (String name : p.getCompletedCriteria()) {
				CriterionProgress c = p.getCriterion(name);
				Instant at = c == null ? null : c.getObtained();
				if (at != null && (last == null || at.isAfter(last))) last = at;
				if (got.size() < MAX_CRITERIA) got.add(clip(name, 64));
			}
			if (p.isDone()) {
				done.addProperty(id, last == null ? 0 : last.getEpochSecond());
			} else {
				JsonObject o = new JsonObject();
				java.util.Set<String> have = new java.util.HashSet<>();
				p.getCompletedCriteria().forEach(have::add);
				o.addProperty("n", holder.value().requirements().count(have::contains));
				o.addProperty("of", holder.value().requirements().size());
				o.add("got", got);
				part.add(id, o);
			}
		}
		JsonObject out = new JsonObject();
		out.add("done", done);
		out.add("part", part);
		return out;
	}

	// { id, model? (when it's drawn as another item), glint? }
	private static JsonObject icon(ItemStackTemplate template) {
		JsonObject o = new JsonObject();
		ItemStack stack = template.create();
		String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
		o.addProperty("id", short_(id));
		Identifier model = stack.get(DataComponents.ITEM_MODEL);
		if (model != null && !model.toString().equals(id)) o.addProperty("model", short_(model.toString()));
		if (stack.hasFoil()) o.addProperty("glint", true);
		return o;
	}

	// "minecraft:story/root" -> "story/root"; other namespaces stay.
	private static String short_(String id) {
		return id.startsWith("minecraft:") ? id.substring(10) : id;
	}

	private static String clip(String s, int max) {
		return s.length() > max ? s.substring(0, max) : s;
	}
}
