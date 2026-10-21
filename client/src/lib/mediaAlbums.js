export const isVisualMedia = (attachment) => /^(image|video)\//.test(attachment.mime_type || '');
export function groupMediaAlbums(messages, firstUnreadId) {
  const groups = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    const visual = message.is_deleted || message.attachments?.some(isVisualMedia);
    const joins = message.album_id && visual && previous?.albumId === message.album_id
      && previous.senderId === message.sender_id && previous.roomId === message.room_id
      && !message._startsDay && message.id !== firstUnreadId;
    if (joins) previous.messages.push(message);
    else groups.push({ albumId: message.album_id && visual ? message.album_id : null,
      senderId: message.sender_id, roomId: message.room_id, messages: [message] });
  }
  return groups;
}
export function viewerItems(messages) {
  return messages.filter((message) => !message.is_deleted).flatMap((message) =>
    (message.attachments || []).filter(isVisualMedia).map((attachment, index) => ({
      key: `${message.client_id || message.id}:${index}`, attachment, message,
    })));
}
