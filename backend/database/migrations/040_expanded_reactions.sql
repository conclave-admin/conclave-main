ALTER TABLE message_reactions DROP CONSTRAINT message_reactions_emoji_check;
ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_emoji_check CHECK (emoji IN ('👍','👎','🎉','✅','❤️','😂','😊','😍','😮','😢','😡','🙏','👏','🔥','💯','🚀','👀','🤔','🙌','💪','🤝','💜','💙','💚','🤍','⭐','✨','💡','📌','🎯','👋','👌','🤞','😎','🥳','🤩','😭','😅','😴','🫡','🤗','🤯','🤦','🙈','💔','☕','🍰','🏆'));
