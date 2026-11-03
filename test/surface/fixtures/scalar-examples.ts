export const scalarExamples = [
  {
    name: "quotes, whitespace and backslashes",
    value: 'a "b c" C:\\tmp\\',
    quoted: [
      String.raw`'a "b c" C:\tmp\'`,
      String.raw`'"a \"b c\" C:\tmp\\"'`,
      String.raw`^"a \^"b c\^" C:\tmp\\^"`,
    ],
  },
  {
    name: "trailing backslash",
    value: "C:\\folder\\",
    quoted: [
      String.raw`'C:\folder\'`,
      String.raw`'"C:\folder\\"'`,
      String.raw`^"C:\folder\\^"`,
    ],
  },
  {
    name: "space",
    value: "one two",
    quoted: ['"one two"', '"one two"', '"one two"'],
  },
  {
    name: "double quote",
    value: 'a"b',
    quoted: [String.raw`'a"b'`, String.raw`'"a\"b"'`, String.raw`^"a\^"b^"`],
  },
  {
    name: "single quote",
    value: "it's",
    quoted: ['"it\'s"', '"it\'s"', '"it\'s"'],
  },
  {
    name: "percent expansion",
    value: "%PATH%",
    quoted: ["'%PATH%'", "'\"%PATH%\"'", '^"^%PATH^%^"'],
  },
  {
    name: "ampersand and caret",
    value: "a&b^c",
    quoted: ['"a&b^c"', '"a&b^c"', '"a&b^c"'],
  },
  {
    name: "metacharacters beside quotes",
    value: "a\"&^|<>%PATH%' b",
    quoted: [
      String.raw`'a"&^|<>%PATH%'\'' b'`,
      String.raw`'"a\"&^|<>%PATH%'' b"'`,
      String.raw`^"a\^"^&^^^|^<^>^%PATH^%' b^"`,
    ],
  },
] as const;

export const exampleShells = ["POSIX", "PowerShell 5.1", "cmd"] as const;
