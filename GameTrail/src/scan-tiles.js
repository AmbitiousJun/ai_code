// Keep the original stride grid intact, including its partial edge tiles.
function scanTiles(image, template, width, height, stride) {
  const maxX = image.width - width, maxY = image.height - height;
  if (!Number.isFinite(template.left) || !Number.isFinite(template.top))
    return [{left:0, top:0, right:maxX, bottom:maxY}];

  const x = (template.left + template.width / 2) * image.width / template.viewWidth - width / 2;
  const y = (template.top + template.height / 2) * image.height / template.viewHeight - height / 2;
  const size = Math.ceil(48 / stride) * stride;
  const tiles = [];
  for (let top = 0; top <= maxY; top += size) {
    for (let left = 0; left <= maxX; left += size) {
      const right = Math.min(left + size - stride, maxX);
      const bottom = Math.min(top + size - stride, maxY);
      const dx = Math.max(left - x, 0, x - right);
      const dy = Math.max(top - y, 0, y - bottom);
      tiles.push({left, top, right, bottom, distance:dx * dx + dy * dy});
    }
  }
  return tiles.sort((a, b) => a.distance - b.distance);
}

module.exports = {scanTiles};
