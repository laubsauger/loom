// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NativeInputSection, nativeInputSectionParameters } from "./syphon-section.tsx";
import type { ParameterEditor } from "./parameter-editor.ts";
import { desktopInputBridge } from "@devices/native-input.ts";
import { nodeRuntimeRequirements } from "@domain/types/node-definition.ts";
import { runtimeRequirement } from "@domain/types/requirements.ts";
import { syphonInNode } from "@nodes/definitions/syphon-in.ts";
import { ndiInNode } from "@nodes/definitions/ndi-in.ts";
import { spoutInNode } from "@nodes/definitions/spout.ts";

/* T1340b: the section is handed the NODE'S OWN declaration, so these tests read it off the
   definition rather than spelling a list the definition could drift away from. */
const requires = {
  syphon: nodeRuntimeRequirements(syphonInNode, {}),
  ndi: nodeRuntimeRequirements(ndiInNode, {}),
  spout: nodeRuntimeRequirements(spoutInNode, {}),
};
vi.mock("@devices/native-input.ts", () => ({ desktopInputBridge: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("lists exact sources, never opens one while inspecting, and commits through the editor", async () => {
  const list = vi.fn(async () => [{ id: "uuid", name: "Camera", app: "Sender" }]);
  const open = vi.fn(); const setParameter = vi.fn();
  vi.mocked(desktopInputBridge).mockReturnValue({ list, open } as never);
  render(<NativeInputSection transport="syphon" requirements={requires.syphon} nodeId="input" source="" editor={{ setParameter } as unknown as ParameterEditor} />);
  await waitFor(() => expect(screen.getByText("Sender / Camera")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("Syphon source"), { target: { value: "uuid" } });
  expect(setParameter).toHaveBeenCalledWith("input", "source", "uuid", "commit");
  expect(open).not.toHaveBeenCalled();
  expect(nativeInputSectionParameters()).toEqual(["source"]);
});
it("names what this machine is missing in the library's own tags, not a sentence of its own", () => {
  /* T1340b: this used to read "macOS desktop required" — a fourth wording for a fact the
     library called "Desktop only" and "macOS". The words AND the colour now come from the
     one table, and `data-category` is what carries the hue, so asserting it is asserting
     the colour without a screenshot. */
  render(<NativeInputSection transport="syphon" requirements={requires.syphon} nodeId="input" source="" editor={{} as ParameterEditor} />);
  const desktop = runtimeRequirement("desktop");
  expect(screen.getByText(desktop.label).getAttribute("data-category")).toBe("host");
  expect(screen.getByText(desktop.label).getAttribute("title")).toBe(desktop.description);
  expect(screen.getByText(runtimeRequirement("macos").label).getAttribute("data-category")).toBe("platform");
  expect((screen.getByLabelText("Syphon source") as HTMLSelectElement).disabled).toBe(true);
});

it("separates the SDK you install from the machine you need, for NDI", () => {
  render(<NativeInputSection transport="ndi" requirements={requires.ndi} nodeId="input" source="" editor={{} as ParameterEditor} />);
  // Three different KINDS of missing thing, and the reader acts differently on each.
  expect(screen.getByText(runtimeRequirement("desktop").label).getAttribute("data-category")).toBe("host");
  expect(screen.getByText(runtimeRequirement("macos").label).getAttribute("data-category")).toBe("platform");
  expect(screen.getByText(runtimeRequirement("ndi-sdk").label).getAttribute("data-category")).toBe("external");
});

it("NDI discovery uses its own bridge and source selection", async () => {
  const list = vi.fn(async () => [{ id: "Host (Feed)", name: "Host (Feed)", app: "NDI" }]);
  const setParameter = vi.fn();
  vi.mocked(desktopInputBridge).mockReturnValue({ list } as never);
  render(<NativeInputSection transport="ndi" requirements={requires.ndi} nodeId="input" source="" editor={{ setParameter } as unknown as ParameterEditor} />);
  await screen.findByText("NDI / Host (Feed)");
  expect(desktopInputBridge).toHaveBeenCalledWith("ndi");
  fireEvent.change(screen.getByLabelText("NDI source"), { target: { value: "Host (Feed)" } });
  expect(setParameter).toHaveBeenCalledWith("input", "source", "Host (Feed)", "commit");
});

it("Spout preparation marks the unsatisfiable requirement apart from the ones you could go and get", () => {
  render(<NativeInputSection transport="spout" requirements={requires.spout} nodeId="input" source="" editor={{} as ParameterEditor} />);
  // ⚑ The whole point of the fourth category: "Desktop only" and "Windows" are things a
  // reader can act on and "Not implemented" is not, so they must not arrive wearing the
  // same word — the stylesheet has no other way to tell them apart.
  expect(screen.getByText(runtimeRequirement("not-implemented").label).getAttribute("data-category")).toBe("unsupported");
  expect(screen.getByText(runtimeRequirement("windows").label).getAttribute("data-category")).toBe("platform");
  expect((screen.getByLabelText("Spout source") as HTMLSelectElement).disabled).toBe(true);
});

it("injected Spout discovery commits exact source names without opening a feed", async () => {
  const list = vi.fn(async () => [{ id: "Exact Spout name", name: "Exact Spout name", app: "Spout" }]);
  const open = vi.fn(), setParameter = vi.fn();
  vi.mocked(desktopInputBridge).mockReturnValue({ list, open } as never);
  render(<NativeInputSection transport="spout" requirements={requires.spout} nodeId="input" source="" editor={{ setParameter } as unknown as ParameterEditor} />);
  await screen.findByText("Spout / Exact Spout name");
  expect(desktopInputBridge).toHaveBeenCalledWith("spout");
  fireEvent.change(screen.getByLabelText("Spout source"), { target: { value: "Exact Spout name" } });
  expect(setParameter).toHaveBeenCalledWith("input", "source", "Exact Spout name", "commit");
  expect(open).not.toHaveBeenCalled();
});
