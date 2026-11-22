const displayCharacters =
  /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cs}\u2028\u2029"\\]/gu;

export function escapeDisplayText(
  text: string,
  mode: "sink" | "fragment" = "sink",
): string {
  return text.replace(displayCharacters, (character) => {
    if (character === '"' || character === "\\")
      return mode === "fragment" ? `\\${character}` : character;
    if (character === "\n" && mode === "sink") return character;
    let escaped = "";
    for (let i = 0; i < character.length; i++)
      escaped += `\\u${character.charCodeAt(i).toString(16).padStart(4, "0")}`;
    return escaped;
  });
}

export function quoteDisplayText(text: string): string {
  return `"${escapeDisplayText(text, "fragment")}"`;
}
