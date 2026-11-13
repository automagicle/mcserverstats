package dev.mcserverstats.chatlog;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import net.minecraft.core.Holder;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.CustomData;
import net.minecraft.world.item.component.DyedItemColor;
import net.minecraft.world.item.equipment.EquipmentAsset;
import net.minecraft.world.item.equipment.Equippable;
import net.minecraft.world.item.equipment.trim.ArmorTrim;

// What each online player is wearing and carrying, for the 3D model on their dashboard page:
// armor (with trims and dye), both hands, and the weapons, tools and eggs in their inventory.
// Checked every few seconds on the server thread; a player's report is only sent when it changed,
// and at most once a minute, so the dashboard's database sees few writes.
final class GearReporter {
	private static final int CHECK_TICKS = 10 * 20;
	private static final long MIN_GAP_MS = 60_000;
	private static final int MAX_ITEMS = 40;
	// Weapons and tools worth showing in a hand; everything else in the inventory is left out.
	private static final Pattern WEAPON = Pattern.compile("mace|trident|.*_(sword|axe|pickaxe|shovel|spear)");

	private final Uploader uploader;
	private final Map<UUID, String> lastSent = new HashMap<>();
	private final Map<UUID, Long> lastSentAt = new HashMap<>();
	private int ticks;

	GearReporter(Uploader uploader) {
		this.uploader = uploader;
	}

	// Called at the end of every server tick.
	void tick(MinecraftServer server) {
		if (++ticks < CHECK_TICKS) return;
		ticks = 0;
		long now = System.currentTimeMillis();
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			UUID id = player.getUUID();
			if (now - lastSentAt.getOrDefault(id, 0L) < MIN_GAP_MS) continue;
			JsonObject gear;
			try {
				gear = report(player);
			} catch (RuntimeException e) {
				ChatLogMod.LOG.debug("Couldn't read {}'s gear", player.getScoreboardName(), e);
				continue;
			}
			String json = gear.toString();
			if (json.equals(lastSent.get(id))) continue;
			lastSent.put(id, json);
			lastSentAt.put(id, now);
			gear.addProperty("uuid", id.toString());
			gear.addProperty("name", player.getScoreboardName());
			gear.addProperty("ts", now);
			uploader.addGear(id, gear);
		}
	}

	private static JsonObject report(ServerPlayer player) {
		JsonObject out = new JsonObject();
		JsonObject armor = new JsonObject();
		put(armor, "head", player.getItemBySlot(EquipmentSlot.HEAD));
		put(armor, "chest", player.getItemBySlot(EquipmentSlot.CHEST));
		put(armor, "legs", player.getItemBySlot(EquipmentSlot.LEGS));
		put(armor, "feet", player.getItemBySlot(EquipmentSlot.FEET));
		out.add("armor", armor);
		put(out, "mainhand", player.getMainHandItem());
		put(out, "offhand", player.getOffhandItem());

		JsonArray items = new JsonArray();
		for (ItemStack stack : player.getInventory().getNonEquipmentItems()) {
			if (items.size() >= MAX_ITEMS) break;
			if (stack.isEmpty()) continue;
			if (WEAPON.matcher(id(stack).replaceFirst("^minecraft:", "")).matches() || isEgg(stack)) items.add(item(stack));
		}
		out.add("items", items);
		return out;
	}

	private static void put(JsonObject into, String key, ItemStack stack) {
		if (!stack.isEmpty()) into.add(key, item(stack));
	}

	// { id, n?, glint?, model?, egg?, name?, asset?, trim?: { pattern, palette }, dye? }
	private static JsonObject item(ItemStack stack) {
		JsonObject o = new JsonObject();
		String id = id(stack);
		o.addProperty("id", short_(id));
		if (stack.getCount() > 1) o.addProperty("n", stack.getCount());
		if (stack.hasFoil()) o.addProperty("glint", true);

		// Items that look like something else (Egg SMP's eggs are echo shards drawn as spawn eggs).
		Identifier model = stack.get(DataComponents.ITEM_MODEL);
		if (model != null && !model.toString().equals(id)) o.addProperty("model", short_(model.toString()));
		if (isEgg(stack)) o.addProperty("egg", true);
		Component name = stack.get(DataComponents.CUSTOM_NAME);
		if (name != null) o.addProperty("name", clip(name.getString(), 50));

		// Armor: which texture set it wears, its trim (pattern and the palette for this armor), its dye.
		Equippable eq = stack.get(DataComponents.EQUIPPABLE);
		Optional<ResourceKey<EquipmentAsset>> asset = eq == null ? Optional.empty() : eq.assetId();
		asset.ifPresent(key -> o.addProperty("asset", short_(key.identifier().toString())));
		ArmorTrim trim = stack.get(DataComponents.TRIM);
		if (trim != null) {
			JsonObject t = new JsonObject();
			t.addProperty("pattern", short_(trim.pattern().value().assetId().toString()));
			String palette = asset.isPresent()
					? trim.material().value().assets().assetId(asset.get()).suffix()
					: keyName(trim.material());
			t.addProperty("palette", palette);
			o.add("trim", t);
		}
		DyedItemColor dye = stack.get(DataComponents.DYED_COLOR);
		if (dye != null) o.addProperty("dye", dye.rgb() & 0xFFFFFF);
		return o;
	}

	private static String id(ItemStack stack) {
		return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
	}

	// Egg SMP marks its egg items with custom_data { egg: { … } }.
	private static boolean isEgg(ItemStack stack) {
		CustomData data = stack.get(DataComponents.CUSTOM_DATA);
		return data != null && data.copyTag().getCompound("egg").isPresent();
	}

	private static String keyName(Holder<?> holder) {
		return holder.unwrapKey().map(k -> short_(k.identifier().toString())).orElse("");
	}

	// "minecraft:diamond_sword" -> "diamond_sword"; other namespaces stay.
	private static String short_(String id) {
		return id.startsWith("minecraft:") ? id.substring(10) : id;
	}

	private static String clip(String s, int max) {
		return s.length() > max ? s.substring(0, max) : s;
	}
}
