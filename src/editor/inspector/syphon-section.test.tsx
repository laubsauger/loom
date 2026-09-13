// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NativeInputSection, nativeInputSectionParameters } from "./syphon-section.tsx";
import type { ParameterEditor } from "./parameter-editor.ts";
import { desktopInputBridge } from "@devices/native-input.ts";
vi.mock("@devices/native-input.ts", () => ({ desktopInputBridge: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("lists exact sources, never opens one while inspecting, and commits through the editor", async () => {
  const list = vi.fn(async () => [{ id: "uuid", name: "Camera", app: "Sender" }]);
  const open = vi.fn(); const setParameter = vi.fn();
  vi.mocked(desktopInputBridge).mockReturnValue({ list, open } as never);
  render(<NativeInputSection transport="syphon" nodeId="input" source="" editor={{ setParameter } as unknown as ParameterEditor} />);
  await waitFor(() => expect(screen.getByText("Sender / Camera")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("Syphon source"), { target: { value: "uuid" } });
  expect(setParameter).toHaveBeenCalledWith("input", "source", "uuid", "commit");
  expect(open).not.toHaveBeenCalled();
  expect(nativeInputSectionParameters()).toEqual(["source"]);
});
it("names unsupported browser capability instead of inventing a source", () => {
  render(<NativeInputSection transport="syphon" nodeId="input" source="" editor={{} as ParameterEditor} />);
  expect(screen.getByText("macOS desktop required")).toBeTruthy();
  expect((screen.getByLabelText("Syphon source") as HTMLSelectElement).disabled).toBe(true);
});

it("NDI discovery uses its own bridge and source selection", async () => {
  const list = vi.fn(async () => [{ id: "Host (Feed)", name: "Host (Feed)", app: "NDI" }]);
  const setParameter = vi.fn();
  vi.mocked(desktopInputBridge).mockReturnValue({ list } as never);
  render(<NativeInputSection transport="ndi" nodeId="input" source="" editor={{ setParameter } as unknown as ParameterEditor} />);
  await screen.findByText("NDI / Host (Feed)");
  expect(desktopInputBridge).toHaveBeenCalledWith("ndi");
  fireEvent.change(screen.getByLabelText("NDI source"), { target: { value: "Host (Feed)" } });
  expect(setParameter).toHaveBeenCalledWith("input", "source", "Host (Feed)", "commit");
});

it("Spout preparation clearly disables discovery when no native adapter exists", () => {
  render(<NativeInputSection transport="spout" nodeId="input" source="" editor={{} as ParameterEditor} />);
  expect(screen.getByText(/Windows.*not implemented/)).toBeTruthy();
  expect((screen.getByLabelText("Spout source") as HTMLSelectElement).disabled).toBe(true);
});

it("injected Spout discovery commits exact source names without opening a feed", async () => {
  const list = vi.fn(async () => [{ id: "Exact Spout name", name: "Exact Spout name", app: "Spout" }]);
  const open = vi.fn(), setParameter = vi.fn();
  vi.mocked(desktopInputBridge).mockReturnValue({ list, open } as never);
  render(<NativeInputSection transport="spout" nodeId="input" source="" editor={{ setParameter } as unknown as ParameterEditor} />);
  await screen.findByText("Spout / Exact Spout name");
  expect(desktopInputBridge).toHaveBeenCalledWith("spout");
  fireEvent.change(screen.getByLabelText("Spout source"), { target: { value: "Exact Spout name" } });
  expect(setParameter).toHaveBeenCalledWith("input", "source", "Exact Spout name", "commit");
  expect(open).not.toHaveBeenCalled();
});
