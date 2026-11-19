package dev.mcserverstats.chatlog.mixin;

import dev.mcserverstats.chatlog.ChatLogMod;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

// Every system message a player is sent passes through here. Some mods announce things to everyone by
// sending each player the message themselves, which the game doesn't count as a broadcast, so the chat
// log never saw it. ChatLogMod notes who was sent what and, at the end of the tick, logs what went to
// everyone (ChatLogMod.playerMessage). Nothing about the message itself is changed.
@Mixin(ServerPlayer.class)
abstract class ServerPlayerMixin {
	@Inject(method = "sendSystemMessage(Lnet/minecraft/network/chat/Component;Z)V", at = @At("HEAD"))
	private void mcstats$noteSystemMessage(Component message, boolean overlay, CallbackInfo ci) {
		try {
			ChatLogMod.playerMessage((ServerPlayer) (Object) this, message, overlay);
		} catch (RuntimeException e) {
			org.slf4j.LoggerFactory.getLogger("mcstats-chat").debug("Couldn't note a system message", e);
		}
	}
}
