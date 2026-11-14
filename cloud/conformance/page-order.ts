export const pageOrder = (a: string, b: string): number =>
  Number(a.slice(5, -5)) - Number(b.slice(5, -5));
