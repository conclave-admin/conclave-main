export function sharedUrls(content) {
  const candidates = (
    String(content || "").match(/https?:\/\/[^\s<>"']+/gi) || []
  ).map((raw) => {
    let value = raw.replace(/[.,;!?]+$/g, "");
    const pairs = { ")": "(", "]": "[", "}": "{" };
    while (pairs[value.at(-1)]) {
      const end = value.at(-1),
        open = pairs[end];
      if (value.split(end).length <= value.split(open).length) break;
      value = value.slice(0, -1);
    }
    return value;
  });
  return [...new Set(candidates)].filter((value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });
}
