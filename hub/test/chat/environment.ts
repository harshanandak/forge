export function fixtureEnv(values: Readonly<Record<string, string>>) {
  const prior = Object.entries(values).map(
    ([key]) => [key, process.env[key]] as const,
  );
  Object.assign(process.env, values);
  return {
    [Symbol.dispose]() {
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

export function observeSlackEnv() {
  const prior = process.env;
  const reads: string[] = [];
  process.env = new Proxy(prior, {
    get(target, key) {
      if (typeof key === "string" && key.startsWith("SLACK_")) reads.push(key);
      return Reflect.get(target, key) as unknown;
    },
  });
  return {
    reads,
    [Symbol.dispose]() {
      process.env = prior;
    },
  };
}
