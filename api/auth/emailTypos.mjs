// Local parts that no mailbox provider accepts and that only come from typos:
// "ivan-@", "ivan.@", "ivan_@", ".ivan@", "iv..an@". Sending a code there only bounces.
export function hasLocalPartTypo(localPart) {
  return /[-._]$/.test(localPart) || localPart.startsWith(".") || localPart.includes("..");
}
