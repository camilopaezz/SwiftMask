import { getMockState } from "./mockState";

export function ask(_message: string, _options?: unknown): Promise<boolean> {
  return Promise.resolve(getMockState().dialogAskResult ?? true);
}

export function open(_options?: unknown): Promise<string | null> {
  return Promise.resolve(getMockState().dialogOpenResult ?? null);
}

export function save(_options?: unknown): Promise<string | null> {
  return Promise.resolve(null);
}

export function message(
  messageText: string,
  _options?: unknown,
): Promise<string> {
  const state = getMockState();
  state.calls.push({ cmd: "dialog.message", args: { message: messageText } });
  return Promise.resolve(state.dialogMessageResult ?? "Ok");
}

export function confirm(
  _message: string,
  _options?: unknown,
): Promise<boolean> {
  return Promise.resolve(true);
}
