declare const fail: (code: string, message: string) => never;

interface Adapter {
  readonly id: string;
  readonly detect: readonly string[];
}

interface RouteCall {
  readonly input: { readonly role: string; readonly max?: boolean };
  readonly config: { readonly adapters: readonly Adapter[] };
  readonly services: {
    readonly environment: {
      select(names: readonly string[]): Readonly<Record<string, string>>;
    };
  };
}

module.exports = {
  "route.get"({ input, config, services }: RouteCall) {
    if (input.max)
      fail("INPUT_INVALID", "no model allows max; add ~/.forge/routing.yaml");
    let harness = "current";
    for (const adapter of [...config.adapters].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      const environment = services.environment.select(adapter.detect);
      if (Object.values(environment).some((value) => value.length > 0)) {
        harness = adapter.id;
        break;
      }
    }
    return {
      model: "current",
      effort: "high",
      speed: "standard",
      harness,
      singleFamily: true,
      line: `current high standard ${harness} single-family`,
    };
  },
};
