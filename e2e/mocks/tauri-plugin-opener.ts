import { getMockState } from "./mockState";

export function revealItemInDir(path: string | string[]): Promise<void> {
  getMockState().calls.push({ cmd: "revealItemInDir", args: path });
  return Promise.resolve();
}

export function openUrl(_url: string | URL, _openWith?: string): Promise<void> {
  return Promise.resolve();
}

export function openPath(_path: string, _openWith?: string): Promise<void> {
  return Promise.resolve();
}
