export const scalarExamples = [
  {
    name: "quotes, whitespace and backslashes",
    value: 'a "b c" C:\\tmp\\',
    quoted: [
      String.raw`'a "b c" C:\tmp\'`,
      String.raw`'"a ""b c"" C:\tmp\\"'`,
      String.raw`^"a ^"^"b c^"^" C:\tmp\\^"`,
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
    quoted: [String.raw`'a"b'`, String.raw`'"a""b"'`, String.raw`^"a^"^"b^"`],
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
      String.raw`'"a""&^|<>%PATH%'' b"'`,
      String.raw`^"a^"^"^&^^^|^<^>^%PATH^%' b^"`,
    ],
  },
] as const;

export const exampleShells = ["POSIX", "PowerShell 5.1", "cmd"] as const;

export const authoredInputs = [
  {
    name: "string with a single quote and space",
    input: "it's ready",
    quoted: [
      String.raw`'"it'\''s ready"'`,
      String.raw`'\"it''s\u0020ready\"'`,
      String.raw`^"\^"it's ready\^"^"`,
    ],
  },
  {
    name: "empty string",
    input: "",
    quoted: [String.raw`'""'`, String.raw`'\"\"'`, String.raw`^"\^"\^"^"`],
  },
  { name: "number", input: 42, quoted: ["42", "42", "42"] },
  { name: "zero", input: 0, quoted: ["0", "0", "0"] },
  { name: "boolean", input: true, quoted: ["true", "true", "true"] },
  { name: "false", input: false, quoted: ["false", "false", "false"] },
  {
    name: "array",
    input: ["one two", "it's", 3, false],
    quoted: [
      String.raw`'["one two","it'\''s",3,false]'`,
      String.raw`'[\"one\u0020two\",\"it''s\",3,false]'`,
      String.raw`^"[\^"one two\^",\^"it's\^",3,false]^"`,
    ],
  },
  { name: "empty array", input: [], quoted: ["'[]'", "'[]'", '^"[]^"'] },
  { name: "null", input: null, quoted: ["null", "null", "null"] },
] as const;
