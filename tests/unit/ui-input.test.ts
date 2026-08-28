import { describe, expect, it } from "vitest";

import {
  EMPTY_INPUT,
  inputReducer,
  inputValue,
  MAX_INPUT_GRAPHEMES,
  normalizePastedInput,
  splitGraphemes,
} from "../../src/ui/input.js";

function insert(value: string) {
  return inputReducer(EMPTY_INPUT, { type: "insert", value });
}

describe("TUI 输入 reducer", () => {
  it("支持中文、多字符粘贴和换行安全归一化", () => {
    const state = insert("修复\r\n测试\t现在");
    expect(inputValue(state)).toBe("修复 测试 现在");
    expect(state.cursor).toBe(splitGraphemes("修复 测试 现在").length);
    expect(normalizePastedInput("a\0b\nc")).toBe("ab c");
  });

  it("按 grapheme 编辑代理对、ZWJ 和组合字符", () => {
    const value = "A👩‍💻e\u0301中";
    let state = insert(value);
    expect(state.graphemes).toEqual(["A", "👩‍💻", "é", "中"]);

    state = inputReducer(state, { type: "left" });
    state = inputReducer(state, { type: "backspace" });
    expect(inputValue(state)).toBe("A👩‍💻中");
    state = inputReducer(state, { type: "home" });
    state = inputReducer(state, { type: "delete" });
    expect(inputValue(state)).toBe("👩‍💻中");
  });

  it("支持 Left/Right/Home/End/Delete/Backspace 与插入点", () => {
    let state = insert("甲乙丙");
    state = inputReducer(state, { type: "home" });
    state = inputReducer(state, { type: "right" });
    state = inputReducer(state, { type: "insert", value: "中" });
    expect(inputValue(state)).toBe("甲中乙丙");
    state = inputReducer(state, { type: "end" });
    state = inputReducer(state, { type: "backspace" });
    expect(inputValue(state)).toBe("甲中乙");
    expect(inputReducer(state, { type: "clear" })).toEqual(EMPTY_INPUT);
  });

  it("按 grapheme 限制输入长度", () => {
    const state = insert("界".repeat(MAX_INPUT_GRAPHEMES + 20));
    expect(state.graphemes).toHaveLength(MAX_INPUT_GRAPHEMES);
    expect(inputValue(state)).toHaveLength(MAX_INPUT_GRAPHEMES);
  });
});
