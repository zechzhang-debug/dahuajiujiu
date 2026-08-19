export function removeById(items, id) {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const [item] = items.splice(index, 1);
  return { item, index };
}

export function restoreAt(items, removal) {
  if (!removal?.item || !Number.isInteger(removal.index)) return false;
  items.splice(Math.min(removal.index, items.length), 0, removal.item);
  return true;
}
