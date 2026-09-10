// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SyphonSection, syphonSectionParameters } from "./syphon-section.tsx";
import type { ParameterEditor } from "./parameter-editor.ts";
import { desktopInputBridge } from "@devices/native-input.ts";
vi.mock("@devices/native-input.ts", () => ({ desktopInputBridge: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("lists exact sources, never opens one while inspecting, and commits through the editor", async () => {
  const list = vi.fn(async () => [{ id: "uuid", name: "Camera", app: "Sender" }]);
  const open = vi.fn(); const setParameter = vi.fn();
  vi.mocked(desktopInputBridge).mockReturnValue({ list, open } as never);
  render(<SyphonSection nodeId="input" source="" editor={{ setParameter } as unknown as ParameterEditor} />);
  await waitFor(() => expect(screen.getByText("Sender / Camera")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("Syphon source"), { target: { value: "uuid" } });
  expect(setParameter).toHaveBeenCalledWith("input", "source", "uuid", "commit");
  expect(open).not.toHaveBeenCalled();
  expect(syphonSectionParameters()).toEqual(["source"]);
});
it("names unsupported browser capability instead of inventing a source", () => {
  render(<SyphonSection nodeId="input" source="" editor={{} as ParameterEditor} />);
  expect(screen.getByText("macOS desktop required")).toBeTruthy();
  expect((screen.getByLabelText("Syphon source") as HTMLSelectElement).disabled).toBe(true);
});
