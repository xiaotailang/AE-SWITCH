import { describe, expect, it } from "vitest";
import {
  contextCapabilities,
  contextChoice,
  effectiveContext,
} from "./contextPolicy";
import type { ProviderModel, ContextCapabilities } from "../types";

const official = "https://api.openai.com/v1";
const gateway = "https://gateway.example/v1";
const model = (
  id = "gpt-6.1-sol",
  contextWindow: number | null = null,
): ProviderModel => ({
  id,
  contextWindow,
  enabled: true,
  reasoningEfforts: ["xhigh"],
});
const declared = (
  policy: Partial<ContextCapabilities> = {},
): ProviderModel => ({
  ...model("gpt-internal-alias", 500000),
  contextCapabilities: {
    standardWindow: 64000,
    longWindow: 800000,
    source: "endpoint",
    inputMultiplier: 3,
    outputMultiplier: 1,
    endpoint: gateway,
    credentialScope: "a".repeat(64),
    ...policy,
  },
});

describe("endpoint and exact model context pricing", () => {
  it("uses official rules only on the official API, defaulting off and to 80%", () => {
    const selected = model();
    const choice = contextChoice(selected, null, official);
    expect(choice).toEqual({
      model: selected.id,
      longContextEnabled: false,
      compactPercent: 80,
    });
    expect(effectiveContext(selected, choice, official)).toEqual({
      contextWindow: 272000,
      autoCompactTokenLimit: 217600,
    });
    expect(
      effectiveContext(
        selected,
        { ...choice, longContextEnabled: true },
        official,
      ),
    ).toEqual({ contextWindow: 1050000, autoCompactTokenLimit: 840000 });
    expect(selected.reasoningEfforts).toEqual(["xhigh"]);
  });
  it.each([
    gateway,
    "https://api.openai.com.gateway.example/v1",
    "http://api.openai.com/v1",
    "https://api.openai.com:8443/v1",
    "https://api.openai.com/proxy/v1",
    "https://api.openai.com/v1?route=other",
    undefined,
  ])(
    "does not infer a tariff from an official model name at %s",
    (endpoint) => {
      const selected = model("gpt-6.1-sol", 1050000);
      expect(contextCapabilities(selected, endpoint)).toMatchObject({
        standardWindow: 128000,
        longWindow: 128000,
        source: "conservative",
        surcharge: null,
        inputMultiplier: null,
        outputMultiplier: null,
      });
      expect(() =>
        effectiveContext(
          selected,
          { model: selected.id, longContextEnabled: true, compactPercent: 80 },
          endpoint,
        ),
      ).toThrow();
    },
  );
  it("uses a queried internal alias's actual threshold and maximum", () => {
    const selected = declared();
    const choice = contextChoice(selected, null, gateway);
    expect(effectiveContext(selected, choice, gateway)?.contextWindow).toBe(
      64000,
    );
    expect(
      effectiveContext(
        selected,
        { ...choice, longContextEnabled: true },
        gateway,
      ),
    ).toEqual({ contextWindow: 500000, autoCompactTokenLimit: 400000 });
    expect(
      contextChoice(
        model("gpt-other"),
        { ...choice, longContextEnabled: true },
        gateway,
      ).longContextEnabled,
    ).toBe(false);
  });
  it.each([
    [64000, 64000, 51200],
    [1000000, 128000, 102400],
  ])(
    "adapts non-GPT models with an advertised %d-token maximum",
    (maximum, expected, compact) => {
      const selected = model("vendor/coding-alias", maximum);
      const choice = contextChoice(selected, null, gateway);
      expect(choice).toMatchObject({
        longContextEnabled: false,
        compactPercent: 80,
      });
      expect(contextCapabilities(selected, gateway)?.surcharge).toBeNull();
      expect(effectiveContext(selected, choice, gateway)).toEqual({
        contextWindow: expected,
        autoCompactTokenLimit: compact,
      });
    },
  );

  it("does not restore official paid consent for a different Key or reduced maximum", () => {
    const selected = {
      ...model(),
      contextCapabilities: {
        standardWindow: 272000,
        longWindow: 1050000,
        source: "official_model" as const,
        inputMultiplier: 2,
        outputMultiplier: 1.5,
        endpoint: official,
        credentialScope: "a".repeat(64),
      },
    };
    const applied = {
      model: selected.id,
      longContextEnabled: true,
      compactPercent: 75,
      contextWindow: 1050000,
      capabilityScope: "a".repeat(64),
    };
    expect(contextChoice(selected, applied, official).longContextEnabled).toBe(
      true,
    );
    expect(
      contextChoice(
        selected,
        { ...applied, capabilityScope: "b".repeat(64) },
        official,
      ),
    ).toMatchObject({ longContextEnabled: false, compactPercent: 75 });
    expect(
      contextChoice({ ...selected, contextWindow: 300000 }, applied, official)
        .longContextEnabled,
    ).toBe(false);
  });
  it("disables tiers with unknown pricing and resets stale opt-in", () => {
    const selected = declared({
      inputMultiplier: null,
      outputMultiplier: null,
    });
    const saved = {
      model: selected.id,
      longContextEnabled: true,
      compactPercent: 80,
    };
    expect(contextCapabilities(selected, gateway)?.surcharge).toBeNull();
    expect(contextChoice(selected, saved, gateway).longContextEnabled).toBe(
      false,
    );
    expect(() => effectiveContext(selected, saved, gateway)).toThrow();
    expect(
      effectiveContext(
        selected,
        { ...saved, longContextEnabled: false },
        gateway,
      )?.contextWindow,
    ).toBe(64000);
  });
  it("requires saved paid consent to match the queried connection scope", () => {
    const selected = declared();
    const saved = {
      model: selected.id,
      longContextEnabled: true,
      compactPercent: 80,
      contextWindow: 500000,
    };
    expect(contextChoice(selected, saved, gateway).longContextEnabled).toBe(
      false,
    );
    expect(
      contextChoice(
        selected,
        { ...saved, capabilityScope: "b".repeat(64) },
        gateway,
      ).longContextEnabled,
    ).toBe(false);
    expect(
      contextChoice(
        selected,
        { ...saved, capabilityScope: "a".repeat(64) },
        gateway,
      ).longContextEnabled,
    ).toBe(true);
  });
  it.each([
    { surcharge: false, inputMultiplier: null, outputMultiplier: null },
    { inputMultiplier: 1, outputMultiplier: 1 },
  ])(
    "uses confirmed flat-rate capacity without a paid opt-in: %j",
    (policy) => {
      const selected = declared(policy);
      const choice = contextChoice(selected, null, gateway);
      expect(contextCapabilities(selected, gateway)).toMatchObject({
        surcharge: false,
        standardWindow: 500000,
      });
      expect(effectiveContext(selected, choice, gateway)).toEqual({
        contextWindow: 500000,
        autoCompactTokenLimit: 400000,
      });
      expect(() =>
        effectiveContext(
          selected,
          { ...choice, longContextEnabled: true },
          gateway,
        ),
      ).toThrow();
    },
  );
  it("accepts an explicit surcharge declaration without fabricating its multiplier", () => {
    const selected = declared({
      surcharge: true,
      inputMultiplier: null,
      outputMultiplier: null,
    });
    expect(
      effectiveContext(
        selected,
        { model: selected.id, longContextEnabled: true, compactPercent: 80 },
        gateway,
      )?.contextWindow,
    ).toBe(500000);
    expect(contextCapabilities(selected, gateway)?.inputMultiplier).toBeNull();
  });
  it("does not reuse unbound or differently queried capabilities", () => {
    for (const selected of [
      declared({ endpoint: null }),
      declared({ credentialScope: null }),
      declared({ credentialScope: "invalid" }),
    ]) {
      expect(contextCapabilities(selected, gateway)?.source).toBe(
        "conservative",
      );
    }
    expect(
      contextCapabilities(declared(), "https://other.example/v1")?.source,
    ).toBe("conservative");
    expect(contextCapabilities(declared(), gateway + "/")?.source).toBe(
      "endpoint",
    );
    expect(contextCapabilities(model("gpt-5"), official)?.surcharge).toBeNull();
    expect(contextCapabilities(model("claude-test"), gateway)).toBeNull();
  });
  it("rejects malformed declarations and percentages", () => {
    for (const policy of [
      { standardWindow: -1 },
      { longWindow: 1 },
      { inputMultiplier: 0 },
      { outputMultiplier: Infinity },
      { surcharge: false, inputMultiplier: 2 },
    ])
      expect(contextCapabilities(declared(policy), gateway)).toBeNull();
    expect(
      contextCapabilities({ ...declared(), contextWindow: -1 }, gateway),
    ).toBeNull();
    expect(() =>
      effectiveContext(
        model(),
        {
          model: "gpt-6.1-sol",
          longContextEnabled: false,
          compactPercent: 100,
        },
        official,
      ),
    ).toThrow();
  });
});
