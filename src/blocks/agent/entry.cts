declare const fail: (code: string, message: string) => never;

interface Adapter {
  readonly id: string;
  readonly detect: readonly string[];
  readonly skills?: string;
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
    const matches = config.adapters.filter((adapter) => {
      const environment = services.environment.select(adapter.detect);
      return Object.values(environment).some((value) => value.length > 0);
    });
    const harness = matches.length === 1 ? matches[0]!.id : "current";
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
