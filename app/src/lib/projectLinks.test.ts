import { describe, expect, it } from "vitest";
import { projectUrl } from "./projectLinks";

describe("本项目外部链接", () => {
  it("未配置或非法仓库不产生可打开链接", () => {
    for (const repository of [
      null,
      "",
      "../repo",
      "https://github.com/owner/repo",
      "owner/repo?key=secret",
      "owner/repo/extra",
    ]) {
      for (const page of ["source", "license", "tutorial"] as const)
        expect(projectUrl(page, repository)).toBeNull();
    }
  });
  it("教程和许可对应当前源码目录结构", () => {
    expect(projectUrl("source", "example/ae-switch")).toBe(
      "https://github.com/example/ae-switch",
    );
    expect(projectUrl("license", "example/ae-switch")).toBe(
      "https://github.com/example/ae-switch/blob/main/app/LICENSE",
    );
    expect(projectUrl("tutorial", "example/ae-switch")).toBe(
      "https://github.com/example/ae-switch/blob/main/app/docs/tutorial.md",
    );
  });
});
