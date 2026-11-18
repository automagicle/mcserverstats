package dev.mcserverstats.chatlog.mixin;

import com.mojang.brigadier.ParseResults;
import dev.mcserverstats.chatlog.ChatLogMod;
import dev.mcserverstats.chatlog.WhisperSuggestions;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

// Every command (typed by a player, signed or not, or from the console) runs through here. A whisper
// to someone who's only on the dashboard goes to them there instead (ChatLogMod.whisperToWeb);
// everything else runs as usual. If anything goes wrong in the check, the command runs as usual too.
//
// And once the commands are built (at start and on /reload), /msg's name suggestions get the players who
// are on the dashboard too (WhisperSuggestions).
@Mixin(Commands.class)
abstract class CommandsMixin {
	@Inject(method = "<init>", at = @At("RETURN"))
	private void mcstats$webSuggestions(CallbackInfo ci) {
		WhisperSuggestions.apply(((Commands) (Object) this).getDispatcher());
	}

	@Inject(method = "performCommand", at = @At("HEAD"), cancellable = true)
	private void mcstats$whisperToWeb(ParseResults<CommandSourceStack> parse, String command, CallbackInfo ci) {
		try {
			if (ChatLogMod.whisperToWeb(parse.getContext().getSource(), command)) ci.cancel();
		} catch (RuntimeException e) {
			org.slf4j.LoggerFactory.getLogger("mcstats-chat").error("Couldn't check a whisper for the website", e);
		}
	}
}
