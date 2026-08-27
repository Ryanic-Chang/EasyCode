export class OpenAICompatibleProtocolError extends Error {
  constructor() {
    super("OpenAI-compatible 响应不符合受支持的协议子集");
    this.name = "OpenAICompatibleProtocolError";
  }
}
