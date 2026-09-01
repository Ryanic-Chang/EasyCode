import { Box, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useEffect, useReducer, useRef } from "react";

import type { AgentRunner } from "../agent/session.js";
import { safeDisplayLabel, terminationReasonText, toolDisplayName } from "./format.js";
import { EMPTY_INPUT, type InputState, inputReducer, inputValue } from "./input.js";
import { INITIAL_UI_STATE, type TranscriptItem, type UiState, uiReducer } from "./model.js";

export interface EasyCodeAppProps {
  readonly runner: AgentRunner;
  readonly version?: string;
  readonly model: string;
  readonly workspace: string;
  readonly colorEnabled: boolean;
  readonly columns?: number;
  readonly onExitRequested?: () => void;
  readonly onFatalError?: () => void;
}

export interface EasyCodeViewProps {
  readonly state: UiState;
  readonly input: InputState;
  readonly version?: string;
  readonly model: string;
  readonly workspace: string;
  readonly colorEnabled: boolean;
  readonly columns: number;
}

function textColor(enabled: boolean, value: string): Readonly<Record<string, string>> {
  return enabled ? { color: value } : {};
}

function TranscriptLine({ item, colorEnabled }: { readonly item: TranscriptItem; readonly colorEnabled: boolean }) {
  switch (item.type) {
    case "user":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold {...textColor(colorEnabled, "blue")}>
            &gt; 你
          </Text>
          <Text wrap="hard">{item.task}</Text>
        </Box>
      );
    case "turn":
      return (
        <Text bold {...textColor(colorEnabled, "cyan")}>
          - 分析轮次 {item.step}
        </Text>
      );
    case "retry":
      return (
        <Text wrap="hard" {...textColor(colorEnabled, "yellow")}>
          [重试] {item.reason} · 第 {item.attempt}/{item.maxRetries} 次 · {item.delayMs} ms
        </Text>
      );
    case "approval": {
      const label = item.status === "pending" ? "确认" : item.status === "approved" ? "已允许" : "已拒绝";
      const color = item.status === "pending" ? "yellow" : item.status === "approved" ? "green" : "red";
      return (
        <Box
          flexDirection="column"
          borderStyle={item.status === "pending" ? "single" : undefined}
          borderColor={item.status === "pending" && colorEnabled ? "yellow" : undefined}
          paddingX={item.status === "pending" ? 1 : 0}
        >
          <Text wrap="hard" {...textColor(colorEnabled, color)}>
            [{label}] {toolDisplayName(item.toolName)}
          </Text>
          <Text wrap="hard">{item.actionSummary}</Text>
          {item.status === "pending" ? (
            <Text dimColor>一次性授权：按 y 允许；按 n 或 Enter 拒绝（默认拒绝）</Text>
          ) : null}
        </Box>
      );
    }
    case "assistant":
      return (
        <Box flexDirection="column">
          <Text bold>助手</Text>
          <Text wrap="hard">{item.text}</Text>
        </Box>
      );
    case "tool": {
      const label = item.status === "running" ? "运行" : item.status === "success" ? "完成" : "失败";
      const statusColor = item.status === "running" ? "yellow" : item.status === "success" ? "green" : "red";
      return (
        <Box flexDirection="column">
          <Text wrap="hard" {...textColor(colorEnabled, statusColor)}>
            [{label}] {toolDisplayName(item.toolName)} · {item.detail}
          </Text>
          {item.result === undefined ? null : (
            <Text dimColor wrap="hard">
              {item.result}
            </Text>
          )}
        </Box>
      );
    }
    case "error":
      return (
        <Text {...textColor(colorEnabled, "red")} wrap="hard">
          [错误] {item.error.code} · {item.error.message}
        </Text>
      );
    case "complete":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold {...textColor(colorEnabled, item.reason === "complete" ? "green" : "yellow")}>
            [{terminationReasonText(item.reason)}]
          </Text>
          <Text dimColor>
            {item.rounds} rounds · 工具成功 {item.toolSuccesses} · 失败 {item.toolFailures} · tokens{" "}
            {item.totalTokens ?? "unknown"}
            {item.durationMs === undefined ? "" : ` · ${(item.durationMs / 1000).toFixed(1)} s`}
          </Text>
        </Box>
      );
  }
}

function cursorText(input: InputState): { readonly before: string; readonly after: string } {
  return {
    before: input.graphemes.slice(0, input.cursor).join(""),
    after: input.graphemes.slice(input.cursor).join(""),
  };
}

export function EasyCodeView({
  state,
  input,
  version = "开发版",
  model,
  workspace,
  colorEnabled,
  columns,
}: EasyCodeViewProps) {
  const draft = cursorText(input);
  const phaseText =
    state.phase === "running"
      ? "正在运行"
      : state.phase === "awaiting_approval"
        ? "等待确认"
        : state.phase === "cancelling"
          ? "正在取消"
          : "等待输入";
  const phaseColor = state.phase === "idle" ? "green" : state.phase === "cancelling" ? "red" : "yellow";

  return (
    <Box flexDirection="column" width={Math.max(20, columns)}>
      <Box flexDirection="column" borderStyle="single" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold {...textColor(colorEnabled, "cyan")}>
            EasyCode v{safeDisplayLabel(version, "未知")}
          </Text>
          <Text bold {...textColor(colorEnabled, phaseColor)}>
            [{phaseText}]
          </Text>
        </Box>
        <Text dimColor wrap="hard">
          {safeDisplayLabel(model, "未知")} · {safeDisplayLabel(workspace, "workspace")}
        </Text>
      </Box>

      {state.transcript.map((item) => (
        <TranscriptLine key={item.id} item={item} colorEnabled={colorEnabled} />
      ))}

      <Box marginTop={1} borderStyle="single" paddingX={1} minHeight={3}>
        {state.phase === "idle" ? (
          <Text wrap="hard">
            › {draft.before}
            {colorEnabled ? <Text inverse> </Text> : <Text>│</Text>}
            {draft.after}
          </Text>
        ) : state.phase === "awaiting_approval" ? (
          <Text dimColor>› y 允许 / n 或 Enter 拒绝（默认拒绝）</Text>
        ) : (
          <Text dimColor>{state.phase === "cancelling" ? "› 正在等待当前任务清理" : "› 输入已暂停"}</Text>
        )}
      </Box>
    </Box>
  );
}

export function EasyCodeApp({
  runner,
  version = "开发版",
  model,
  workspace,
  colorEnabled,
  columns: columnsOverride,
  onExitRequested,
  onFatalError,
}: EasyCodeAppProps) {
  const [state, dispatch] = useReducer(uiReducer, INITIAL_UI_STATE);
  const [input, dispatchInput] = useReducer(inputReducer, EMPTY_INPUT);
  const { exit } = useApp();
  const windowSize = useWindowSize();
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const phaseRef = useRef(state.phase);
  const inputRef = useRef(input);
  const nextRunIdRef = useRef(1);
  const activeUiRunIdRef = useRef<number | undefined>(undefined);
  const activeApprovalIdRef = useRef<string | undefined>(undefined);
  const exitAfterCancellationRef = useRef(false);
  const mountedRef = useRef(true);

  phaseRef.current = state.phase;
  inputRef.current = input;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = undefined;
      runner.dispose();
    };
  }, [runner]);

  const requestExit = () => {
    onExitRequested?.();
    exit();
  };

  const updateInput = (action: Parameters<typeof inputReducer>[1]) => {
    inputRef.current = inputReducer(inputRef.current, action);
    dispatchInput(action);
  };

  const submit = () => {
    if (phaseRef.current !== "idle") {
      return;
    }
    const task = inputValue(inputRef.current);
    if (task.trim().length === 0) {
      return;
    }

    const uiRunId = nextRunIdRef.current;
    nextRunIdRef.current += 1;
    const controller = new AbortController();
    controllerRef.current = controller;
    activeUiRunIdRef.current = uiRunId;
    phaseRef.current = "running";
    dispatch({ type: "submit", runId: uiRunId, task, at: performance.now() });
    updateInput({ type: "clear" });

    void (async () => {
      try {
        const events = runner.submit(task, { signal: controller.signal });
        for await (const sessionEvent of events) {
          if (!mountedRef.current) {
            return;
          }
          if (sessionEvent.event.type === "approval_required") {
            activeApprovalIdRef.current = sessionEvent.event.request.approvalId;
            phaseRef.current = "awaiting_approval";
          } else if (sessionEvent.event.type === "approval_resolved") {
            activeApprovalIdRef.current = undefined;
            phaseRef.current = "running";
          } else if (sessionEvent.event.type === "complete") {
            activeApprovalIdRef.current = undefined;
            phaseRef.current = "idle";
          }
          dispatch({ type: "agent_event", runId: uiRunId, event: sessionEvent.event, at: performance.now() });
        }
      } catch {
        if (mountedRef.current) {
          onFatalError?.();
          exit(new Error("EasyCode UI runner failed"));
        }
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = undefined;
        }
        if (activeUiRunIdRef.current === uiRunId) {
          activeUiRunIdRef.current = undefined;
        }
        if (mountedRef.current && exitAfterCancellationRef.current) {
          requestExit();
        }
      }
    })();
  };

  usePaste(
    (value) => {
      if (phaseRef.current === "idle") {
        updateInput({ type: "insert", value });
      }
    },
    { isActive: state.phase === "idle" },
  );

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      if (phaseRef.current === "idle") {
        requestExit();
      } else if (phaseRef.current === "running" || phaseRef.current === "awaiting_approval") {
        phaseRef.current = "cancelling";
        dispatch({ type: "cancelling", runId: activeUiRunIdRef.current ?? -1 });
        controllerRef.current?.abort();
      } else {
        exitAfterCancellationRef.current = true;
      }
      return;
    }
    if (phaseRef.current === "awaiting_approval") {
      const lower = value.toLowerCase();
      if (key.return || lower === "n" || lower === "y") {
        const approvalId = activeApprovalIdRef.current;
        if (
          approvalId !== undefined &&
          runner.resolveApproval({ approvalId, approved: !key.return && lower === "y" })
        ) {
          activeApprovalIdRef.current = undefined;
          phaseRef.current = "running";
        }
      }
      return;
    }
    if (phaseRef.current !== "idle") {
      return;
    }
    if (key.return) {
      submit();
    } else if (key.backspace) {
      updateInput({ type: "backspace" });
    } else if (key.delete) {
      updateInput({ type: "delete" });
    } else if (key.leftArrow) {
      updateInput({ type: "left" });
    } else if (key.rightArrow) {
      updateInput({ type: "right" });
    } else if (key.home) {
      updateInput({ type: "home" });
    } else if (key.end) {
      updateInput({ type: "end" });
    } else if (!key.ctrl && !key.meta && value.length > 0) {
      updateInput({ type: "insert", value });
    }
  });

  return (
    <EasyCodeView
      state={state}
      input={input}
      version={version}
      model={model}
      workspace={workspace}
      colorEnabled={colorEnabled}
      columns={columnsOverride ?? windowSize.columns}
    />
  );
}
