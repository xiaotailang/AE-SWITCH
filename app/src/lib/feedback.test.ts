import { describe, expect, it } from "vitest";
import { explainError, safeDiagnostic, providerState } from "./feedback";
import type { RuntimeStatus, TargetStatus } from "../types";

const authenticationFeedback = {
  message: "密钥未通过验证，请检查是否复制完整或已经失效。",
  action: "修改密钥",
  field: "apiKey",
};
const permissionFeedback = {
  message: "此密钥没有访问权限，请核对供应商的模型权限或 IP 限制。",
  action: "检查密钥",
  field: "apiKey",
};
const addressFeedback = {
  message: "未找到可用的模型接口，请核对供应商提供的 API 接入地址。",
  action: "修改地址",
  field: "baseUrl",
};
const rateLimitFeedback = {
  message: "供应商暂时限制请求，请稍后重试。填写内容已保留。",
  action: "稍后重试",
  field: null,
};
const externalChangeFeedback = {
  message:
    "其他软件修改了 API 配置，本次没有覆盖。请撤回相应修改后重试，处理方法见使用说明。",
  action: "查看配置",
  field: null,
};
const bridgeFeedback = {
  message: "后台兼容服务正在恢复，原配置已保留。恢复后可重试。",
  action: "重试",
  field: null,
};
const directoryFeedback = {
  message: "配置位置尚未确定，请在下方选择客户端实际使用的位置。",
  action: "选择配置位置",
  field: null,
};
const modelFeedback = {
  message:
    "此密钥没有返回可用模型。请检查模型权限；已有供应商可继续使用已保存的模型。",
  action: "重新获取",
  field: null,
};
const networkFeedback = {
  message: "暂时无法连接供应商。填写内容已保留，可以检查网络后重试。",
  action: "重试",
  field: null,
};

describe("结果与异常提示", () => {
  it("认证、限流、目录冲突给不同操作", () => {
    expect(explainError({ code: "http", message: "HTTP 401" }).field).toBe(
      "apiKey",
    );
    expect(explainError({ code: "http", message: "HTTP 404" }).field).toBe(
      "baseUrl",
    );
    expect(explainError({ code: "http", message: "HTTP 429" }).action).toBe(
      "稍后重试",
    );
    expect(
      explainError({ code: "directory_selection", message: "ambiguous" })
        .action,
    ).toBe("选择配置位置");
  });
  it("配置路径中的实际 UUID 不会把外部修改误判为 HTTP 403", () => {
    const message =
      "配置已被外部修改：D:\\example-project\\.cache\\native-e2e-sandbox\\77f34630b35e46888c995403814096a4\\config.toml";
    expect(explainError({ code: "external_change", message })).toEqual(
      externalChangeFeedback,
    );
  });
  it.each([401, 403, 4041])("兼容服务端口 %s 保留恢复提示", (port) => {
    expect(
      explainError({
        code: "bridge_unavailable",
        message: `兼容服务 http://127.0.0.1:${port}/v1 尚未就绪`,
      }),
    ).toEqual(bridgeFeedback);
  });
  it.each(["provider_changed", "configuration_changed"])(
    "%s 中的模型数字保留刷新配置提示",
    (code) => {
      const message = "模型 model-429-preview 的配置已修改，请重新读取";
      expect(explainError({ code, message })).toEqual({
        message,
        action: "刷新配置",
        field: null,
      });
    },
  );
  it.each([
    ["missing_key", authenticationFeedback],
    ["invalid_url", addressFeedback],
    ["supplier_json", addressFeedback],
    ["directory_selection", directoryFeedback],
    ["discovery_changed", directoryFeedback],
    ["external_change", externalChangeFeedback],
    ["bridge_unavailable", bridgeFeedback],
    ["no_models", modelFeedback],
    ["model_response", modelFeedback],
    ["network", networkFeedback],
  ])("结构化错误 %s 优先于消息中的 HTTP 状态", (code, feedback) => {
    expect(explainError({ code, message: "上次请求返回 HTTP 429" })).toEqual(
      feedback,
    );
  });
  it.each(["provider_changed", "configuration_changed"])(
    "结构化错误 %s 保留包含 HTTP 状态的原始消息",
    (code) => {
      const message = "配置已更新，上次请求返回 HTTP 403";
      expect(explainError({ code, message })).toEqual({
        message,
        action: "刷新配置",
        field: null,
      });
    },
  );
  it("结构化网络错误优先于消息中的模型文本", () => {
    expect(
      explainError({ code: "network", message: "连接失败，没有返回可用模型" }),
    ).toEqual(networkFeedback);
  });
  it.each([
    [401, authenticationFeedback],
    [403, permissionFeedback],
    [404, addressFeedback],
    [405, addressFeedback],
    [429, rateLimitFeedback],
  ])("真实 HTTP %s 保留完整中文反馈", (status, feedback) => {
    expect(
      explainError({
        code: "supplier_http",
        message: `请求失败（HTTP ${status}）`,
      }),
    ).toEqual(feedback);
    expect(explainError(new Error(`上游 HTTP ${status}：请求失败`))).toEqual(
      feedback,
    );
  });
  it.each([
    "HTTP/1.1 403 Forbidden",
    "http status code: 403",
    "status: 403",
    "status code = 403",
    "状态码：403",
  ])("明确的状态上下文 %s 可以识别权限错误", (message) => {
    expect(explainError(message)).toEqual(permissionFeedback);
  });
  it.each([
    "配置路径 G:\\sandbox\\77f34630b35e46888c995403814096a4\\config.toml 无法读取",
    "服务端口 http://127.0.0.1:401/v1 尚未就绪",
    "服务端口 http://127.0.0.1:403/v1 尚未就绪",
    "服务端口 http://127.0.0.1:4041/v1 尚未就绪",
    "模型 model-429-preview 尚未就绪",
    "模型 http403-model 尚未就绪",
    "HTTP 4031",
    "HTTP 4041",
    "status code: 4290",
    "原始错误 401 403 404 405 429",
  ])("消息中的非状态数字保持原始反馈：%s", (message) => {
    const expected = { message, action: "重试", field: null };
    expect(explainError(message)).toEqual(expected);
    expect(explainError({ code: "unknown", message })).toEqual(expected);
  });
  it.each([
    ["没有返回可用模型", modelFeedback],
    ["未找到当前模型", modelFeedback],
    ["请求超时", networkFeedback],
    ["连接供应商失败", networkFeedback],
  ])("无结构化错误仍保留文本反馈：%s", (message, feedback) => {
    expect(explainError(message)).toEqual(feedback);
  });
  it("诊断不包含输入密钥与Bearer内容", () => {
    const output = safeDiagnostic(
      {
        code: "network",
        message: "fake-private-value Bearer second-secret sk-third-secret",
      },
      ["fake-private-value"],
    );
    expect(output).not.toMatch(
      /fake-private-value|second-secret|sk-third-secret/,
    );
  });
  it("文件成功不能掩盖重启、服务恢复或待更新", () => {
    const status = { state: "applied" } as TargetStatus;
    const runtime = {
      restartRequired: true,
      bridgeRequired: false,
      bridgeHealthy: true,
    } as RuntimeStatus;
    expect(providerState(status, runtime, "codex").label).toBe("待重启");
    expect(
      providerState(
        status,
        { ...runtime, bridgeRequired: true, bridgeHealthy: false },
        "codex",
      ).label,
    ).toBe("正在恢复");
    expect(
      providerState({ ...status, state: "saved_changes" }, runtime, "codex")
        .label,
    ).toBe("待更新");
    expect(providerState(status, undefined, "codex").label).toBe("已配置");
  });
});
