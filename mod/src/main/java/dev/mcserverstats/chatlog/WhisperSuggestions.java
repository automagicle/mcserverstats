package dev.mcserverstats.chatlog;

import java.lang.reflect.Field;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.builder.RequiredArgumentBuilder;
import com.mojang.brigadier.suggestion.SuggestionProvider;
import com.mojang.brigadier.suggestion.Suggestions;
import com.mojang.brigadier.suggestion.SuggestionsBuilder;
import com.mojang.brigadier.tree.ArgumentCommandNode;
import com.mojang.brigadier.tree.CommandNode;

import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;

// Name suggestions for /msg (and /tell and /w, which lead to it) that include the roster players with
// the dashboard open, marked <web>, as well as everyone in game.
//
// The game normally suggests player names on the player's own side, from its tab list, so it can't know
// about anyone on the website. Giving the command's player argument a suggestion provider of our own
// makes the game ask the server instead (the way it does for some vanilla commands): the answer is what
// the game would have suggested (names in game, @-selectors) plus the website's names. Whisper
// handling itself is unchanged; this only adds suggestions. Applied each time the commands are built
// (at start and on /reload), by CommandsMixin.
public final class WhisperSuggestions {
	private static final Component WEB = Component.literal("<web>").withStyle(ChatFormatting.GRAY);

	private WhisperSuggestions() { }

	public static void apply(CommandDispatcher<CommandSourceStack> dispatcher) {
		try {
			CommandNode<CommandSourceStack> msg = dispatcher.getRoot().getChild("msg");
			if (msg == null) return;
			CommandNode<CommandSourceStack> targets = msg.getChild("targets");
			if (!(targets instanceof ArgumentCommandNode<CommandSourceStack, ?> arg)) return;
			ArgumentCommandNode<CommandSourceStack, ?> replacement = rebuild(arg);
			remove(msg, "targets");
			msg.addChild(replacement);
		} catch (ReflectiveOperationException | RuntimeException e) {
			ChatLogMod.LOG.warn("Couldn't add website players to /msg suggestions; whispers still work", e);
		}
	}

	// The same argument (type, children, permission, redirect), with suggestions from the server.
	private static <T> ArgumentCommandNode<CommandSourceStack, T> rebuild(ArgumentCommandNode<CommandSourceStack, T> arg) {
		SuggestionProvider<CommandSourceStack> suggest = (ctx, builder) -> {
			CompletableFuture<Suggestions> game = arg.getType().listSuggestions(ctx, builder);
			SuggestionsBuilder web = new SuggestionsBuilder(builder.getInput(), builder.getStart());
			String typed = builder.getRemainingLowerCase();
			if (!typed.startsWith("@")) {
				for (String name : ChatLogMod.webOnlyPlayers()) {
					if (name.toLowerCase().startsWith(typed)) web.suggest(name, WEB);
				}
			}
			return game.thenCombine(web.buildFuture(), (a, b) -> Suggestions.merge(builder.getInput(), List.of(a, b)));
		};
		RequiredArgumentBuilder<CommandSourceStack, T> b = RequiredArgumentBuilder.<CommandSourceStack, T>argument(arg.getName(), arg.getType())
				.requires(arg.getRequirement())
				.forward(arg.getRedirect(), arg.getRedirectModifier(), arg.isFork())
				.executes(arg.getCommand())
				.suggests(suggest);
		for (CommandNode<CommandSourceStack> child : arg.getChildren()) b.then(child);
		return b.build();
	}

	// Brigadier can add a child but not take one away, and adding one with the same name merges into it.
	@SuppressWarnings("unchecked")
	private static void remove(CommandNode<CommandSourceStack> parent, String name) throws ReflectiveOperationException {
		for (String field : new String[] { "children", "arguments", "literals" }) {
			Field f = CommandNode.class.getDeclaredField(field);
			f.setAccessible(true);
			((Map<String, ?>) f.get(parent)).remove(name);
		}
	}
}
