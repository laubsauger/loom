# Flying a camera from its picture, and a camera that stays with what moves

Design for §T970 and §T1656b. 2026-10-06. No code in this note; the coverage half (§T1655b)
is built and is what section 1 describes.

The owner, twice: *"i'm still missing a way to actually change the position of the camera in
the camera node via flying around in that preview instead of manually having to deal with it"*.

## 1. What exists today

Two stores wear one interface (`PreviewOrbitStore`), and the difference between them is the
whole subject. The **inspection orbit** (`preview-orbit-store.ts`) is view state: drag, shift-drag,
wheel and, in the viewer, W A S D E Q move a camera over a synthesized picture (a pointset,
a geometry, a light, a material). It writes nothing, mints no revision and is not saved. The
**camera gizmo** (`camera-gizmo-store.ts`, §T692) takes the same gestures on a tile that is
drawn through a node's own Eye and Look At and writes those two parameters through the
parameter editor: one undo step per drag, a driven channel masked out and never written.
Before §T1655b the gizmo was offered only on a camera nothing rendered through, its own tile
did not follow the write, and the viewer's orbit was attached to a hidden canvas; all three
are fixed and gated. After it, every 3D row carries one of three answers from the compiler
(`ResolvedOutput.previewCamera`): `orbit`, `pose` (camera, projector, Render Surface and
Render Instances with no camera named), or `none` with a reason ("Framed by camera_rig." on
a Render). When this note was written the gizmo had no fly, the viewer could not move a
camera at all (it said "drag on its tile in the graph"), and a fully driven camera could
only be refused: slice 1 built those three (section 8). What still does not exist: a free
view of a Render's scene, and a command that sets a pose in one step.

## 2. How the reference tools do it

Read from the vendors' documentation on 2026-10-06 by a research pass that fetched each page
and quoted the sentence; I did not re-open the pages. READ means the sentence was seen on the
page; INFERRED is marked. Bases: TD `https://docs.derivative.ca/`, Notch
`https://manual.notch.one/2026.1/en/docs/reference/`, Blender
`https://docs.blender.org/manual/en/latest/`.

| | Fly while looking through the camera (it follows) | Fly a free view, then commit it | Keep a camera with a moving subject |
|---|---|---|---|
| **TouchDesigner** | Geometry Viewer, **Lock Camera**: "tumbling, zooming, or repositioning the view will update the camera's position to keep in sync with the view" (`Geometry_Viewer`, READ). A Camera COMP's node viewer is the one viewer whose navigation writes parameters: "Moving content inside a node viewer does not affect its transforms or parameters. Exception : Camera COMP" (`Node_Viewer`, READ). | **Save View to**: "takes the current view in the viewer and saves it out to whichever camera is selected from the menu" (`Geometry_Viewer`, READ). | Wire a COMP into the camera's top connector: "that COMP is its transform parent" (`3D_Parenting`, READ). **Parent Transform Source**: Parent (Hierarchy), Specify Parent Object, World Origin (`Camera_COMP`, READ). **Look At**: "it will continue to face that Component, even if you move it" (READ). |
| **Notch** | Not found as a statement. INFERRED weakly from the shortcut table's "Regular Camera" column that navigating a user camera moves it. | Camera node, right-click: "Camera Options > **Set To Current View**" moves the camera to the editor camera's position (`nodes/cameras/camera/`, READ). | Cameras "inherit the transformation values of parent nodes"; per channel, "Inherit the world position from the parent only, rotation and scale will be ignored"; a **Target Node** input turns the camera "to always direct the z axis towards the input" (`nodes/cameras/`, READ). |
| **Blender** | **Lock Camera to View**: "the camera becomes 'glued' to the view and will follow it around as you navigate" (`editors/3dview/sidebar.html`, READ). Walk and Fly: "When activated from a camera view, the camera will move along with you" (`navigate/walk_fly.html`, READ). | **Align Active Camera to View**, Ctrl-Alt-Numpad0: "Moves and rotates the active camera so that it matches the current viewport position and orientation" (`navigate/align.html`, READ). | Parenting; Track To; and, with a parent, **Camera Parent Lock**: "When the camera is locked to the view, the root parent is transformed rather than the camera" (`object/properties/relations.html`, READ). |

Navigation, for the gestures: TD tumbles on LMB, dollies on MMB or wheel, tracks on RMB, and
has W A S D Q E only in the `cameraViewport` palette component (READ). Notch is Alt + mouse
buttons, with no W A S D or fly found. Blender's Walk is W A S D, E Q, Shift faster, and
LMB to keep or Esc to go back (READ): a flight there is one action you accept or cancel.

Three things to take. All three tools have the one-shot commit, and two have the live lock:
they are different gestures and both are wanted. In all three, "stays with the subject" is a
PARENT, never a baked number. And Blender's parent lock states the rule section 4 needs: when
a camera has a parent, what a flown view writes is a choice, and it is stated.

## 3. The gesture

**Both, in this order: lock first, free view second.**

**Lock ("Fly camera_rig").** The viewer, whenever its picture is drawn through a camera: a
camera node, a Render or any other picture framed by one (the compiler already says which,
`through-camera`), or a node with its own Eye and Look At. The camera button in the viewer's
bar, which today is inert on these rows, becomes the toggle and NAMES THE NODE IT WILL WRITE:
"Fly camera_rig". Armed, the viewer's existing gestures write that camera through the gizmo
store: drag orbits Eye about Look At, shift-drag trucks both, the wheel dollies, W A S D E Q
translate both along the view's axes (shift is faster), which the gizmo store gains. Roll
and FOV stay parameters. The picture is the camera's own at every moment, so nothing is
falsified (§T614 holds by construction) and the cost is a uniform write per frame: no second
pass, nothing in the compiler.

- *One undo step* per drag, per wheel burst (400 ms idle, as the gizmo does now) and per
  flight: from the first fly key going down to the last coming up.
- *Before*: the bar reads "Framed by camera_rig." and the button says "Fly camera_rig".
  *After arming*: the button is lit, the readout says "Flying camera_rig: every move is an
  edit, undo steps back", and the camera's tile and every Render through it move with it.
- *Keys*, as rows of the keymap (`viewer` context, rebindable, in the shortcut editor and the
  palette): `c` toggles `viewer.flyCamera`; the fly keys are the existing `viewer.fly` rows,
  routed to the armed store. `h` LEAVES the mode and writes nothing: home must never be an
  edit, and the way back is undo. Menus-as-data: "Fly this camera in the viewer" on a camera
  node, "Fly its camera (camera_rig)" on a Render.
- *It stays findable* because the sentence that says there is no inspection camera here is
  the place the button is: one visible line, naming the camera.

This is the variant §T692 rejected for the Render's TILE, for three reasons. Each is met by
moving it to the viewer and naming the target: the tile contract (a tile gesture inspects the
node it is on) is untouched because tiles do not change; the camera reference is resolved by
the compiler and shown before the first press; and a picture with no camera has no button.

**Free view, then "Set camera from view".** The lock cannot serve one case: looking around
WITHOUT editing, which is what you want before you know where the camera should go and the
only safe thing on a rigged camera. So the viewer gets a second state on the same button
group, "Free view": the scene through an inspection camera that starts at the camera's
current world pose and FOV. It must not change what the Render outputs, so it is a VIEWPORT
ROW, the mechanism §T1311b built for raymarchers: the compiler clones the Render's draw
passes into a target nothing reads, the override writes that clone's camera uniforms, and
the row exists only while a viewer is watching it. Then one command, `camera.setPose`, from
"Set camera_rig from this view" in the bar, on the camera's menu, and on `mod+shift+c`: it
writes Eye and Look At (and FOV only if a later gesture changes it in the free view: today
none does, so framing is preserved without carrying it) as ONE patch and drops back to the
camera's own view. One undo.

- *Which camera, when several exist*: never a guess. It is the camera that frames the
  picture the viewer is showing, by name on the button; from a camera node's own menu it is
  that node.
- `camera.setPose` is also what an agent calls, and it REFUSES rather than half-writes: if
  any channel it must write is driven it changes nothing and names the channel and its mode.

## 4. A driven pose

The owner's `camera_rig` has all six channels on expressions and follows a robot travelling
3 to 8 m a second. Committing a flown view would replace six expressions with six numbers,
and the camera would stop following. Three options:

- **Refuse** (what §T1655b ships): no control, "Driven by expressions (Eye, Look At)." Honest
  and useless for the ask.
- **Bake**: replace the expressions. Destroys the rig. Not offered, by any gesture.
- **A parent frame** (§T1656b), recommended. The camera gains two parameters and its Eye and
  Look At become offsets in the frame they define:

| Parameter | Type, units | Default | Meaning |
|---|---|---|---|
| Origin | vector, scene units (the owner's metres) | 0, 0, 0 | Where the frame is. World Eye = Origin + frame · Eye; the same for Look At. |
| Heading | vector, a direction | 0, 0, 0 | The way the frame faces: its forward, which is its −z. AS BUILT, only the horizontal part is read, so the frame turns about the vertical and never tilts. Zero (or straight up or down) means axes stay the world's, so only position is inherited (Notch's "world position from the parent only"). |

  Both are ordinary drivable vectors, so the frame can be anything an expression can read: a
  channel triple, another node's Translate (`op('geometry_hull').par.translate.x`), a value
  node. The rig then lives in Origin and Heading, and Eye and Look At go back to Constant: the
  gizmo and the lock write them as they do now, in the frame, and the flown view travels with
  the subject. That is the consumer's "Free camera" case with no new mechanism.
- *What the gizmo writes with a frame set*: the same two parameters, unchanged in code,
  because it already orbits Eye about Look At in the space they are stored in. The pose it
  reads at gesture start is the local one.
- *What "Set camera from view" writes*: the free view is a world pose, so the command takes
  it into the frame as it stands on the frame being shown, then writes the local offsets, as
  one patch. This is Blender's parent-lock question answered the other way on purpose: the
  camera's OFFSET is written, never the parent, because the parent here is the rig.
- *What the tile shows*: the picture through the composed pose, as now. A camera whose Origin
  is driven and whose Eye is free has the toggle; one whose Eye and Look At are still all
  driven keeps the sentence.
- *What it costs in the compiler*: one composition where the camera payload is built
  (`scene.ts`), so every consumer of the payload's eye and matrix gets world values and none
  of them changes. Values only, so it animates as a uniform write and never rebuilds. Two
  parameters on a node definition, which reaches the catalogue walkers.
- *Not in this design*: a POINT OF A POINTSET as the parent. Point positions live in GPU
  buffers and the camera matrix is a CPU value; following one needs either a readback per
  frame (latency, and the preview path forbids readback) or the view matrix composed in every
  scene shader from a bound buffer. Filed as a row, not built on a guess.

## 5. What a Render's inspection orbit is after this

Still nothing, on purpose. A Render's tile and its output are the picture through its camera
(§T614), and that does not move. What a Render gains is around it: the sentence naming its
camera (built), the lock that flies that camera from the viewer (a document edit, named), and
the free view, which is a second target nothing downstream reads. "Inspection never writes,
and the node's output is never an inspection" survives all three.

## 6. Slices, each landable alone

(Built on 2026-10-06 as "slice 1": items 2 and 3 below, with the tile toggle's minimum
size. Items 1 and 4 are the next slice. Section 8 says what was ruled in the building.)

1. **`camera.setPose`**: the command, its refusal on a driven channel, the agent tool.
   Accepted when one call is one undo step, a refused call changes nothing and names the
   channel, and a Render through that camera changes on Dawn by the exact matrix.
2. **Lock in the viewer** ("Fly camera_rig"): the button, `c`, fly on the gizmo store, the
   readout line. Accepted in the GPU lane: viewer on a Render, arm, hold W, the camera's Eye
   moved along its view axis, the Render's tile changed, one undo restores both; `h` writes
   nothing; a driven camera has no button and keeps its sentence.
3. **Origin and Heading** (§T1656b). Accepted when a camera with a driven Origin and Constant
   offsets flies and keeps following (two frames, the offset identical, the world pose moved),
   the matrix is exact on Dawn for a non-zero Heading, and a document without the parameters
   renders byte-identical.
4. **Free view and "Set camera from view"**: the Render's viewport row, the state on the
   button, the commit. Accepted when the Render's own output is byte-identical with the free
   view on, the viewport row is absent with no viewer watching, the commit is one patch, and
   with a frame set it writes the local offset.

Left out, as row text for the lead to number:

- A camera's frame from a POINT of a pointset (position and orient attribute), composed on
  the GPU; design first, with the cost per scene shader measured.
- A Camera Select: one camera payload out of several by index or blend, so a panel's "Free
  camera" toggle switches rig and flown camera without a recompile.
- A stock-scene tile (camera, light, material, geometry, projector) whose node only READS a
  moving value, through an expression that follows time or a control, shows the values of
  the last edit made ON that node: the per-frame path and the values lane both splice
  passes and keep the base plan's rows (`frame-compile.ts`), and that tile's values are on
  its row. The fix is for the lane to re-derive the rows from the payloads it already
  captures. Found by §T1655b, which made only a write ON such a node compile in full.
- The preview program description is rebuilt when a synthesized tile's values move
  (§T1241's cost, once per edit now); push values without a rebuild.
- Tile chrome whose corner is under a node in front is hidden (§T1655b); on a document
  that overlaps its nodes, such as the owner's, a Render's sentence is then not shown at
  all. Move it to a corner that is not covered, or decide that overlap is the document's.
- Fly a projector from the viewer (it has the tile gizmo since §T1655b).
- A FOV gesture in the free view, and with it FOV travelling in the commit.

## 7. Questions for the owner

Each is a choice between named options; the first is my recommendation.

1. **How do you want to fly a camera?** `Both` (look through it and it follows; and a free
   look-around you then commit) / `Lock` only / `Free` only.
2. **Your camera_rig is on expressions. What should flying it do?** `Origin` (the camera gets
   an Origin and a Heading that your expressions drive; Eye and Look At become offsets you
   fly, and they stay with the robot) / `Refuse` (as now: it says why and does nothing).
3. **Where do you fly from?** `Viewer` (the big picture; tiles keep what they have) /
   `Tiles too` (a Render's own tile also flies its camera).
4. **While you look through a camera and fly, is every move an edit?** `Yes` (undo steps back,
   nothing to confirm) / `Confirm` (Blender's Walk: keep with a click, Esc throws it away).
5. **The free look-around draws the scene a second time while it is on. Acceptable?** `Yes` /
   `No` (then only Lock is built).
6. **At small zoom the camera button on a tile is about 5 px (alt+drag still works). Keep
   it?** `Minimum` (never smaller than about 12 px, like the node's name) / `Scale` (as now).

## 8. Slice 1 as built (2026-10-06), and what was ruled in the building

Built on the recommendations above, before the owner answered the six questions. Each rule
here is one edit to turn.

**The lock.** A viewer whose picture is drawn through a movable pose shows a button named
for the node it will write: "Fly camera_rig". It, or `c` (`viewer.flyCamera`, a keymap row
in the viewer context), arms it. Armed, the picture's drag, shift-drag, wheel and fly keys
go to a document-writing camera store and not to the inspection one. A drag never arms it,
and unarmed nothing in the viewer edits anything. `h` leaves and writes nothing. Another
subject in the viewer, or a pose that stops being movable, leaves too.

**How a held key becomes undo steps: ONE FLIGHT IS ONE STEP.** A flight runs from the first
fly key going down until the last one comes up, the pane loses focus, or (from the palette
or an agent) one discrete step is taken. However many keys were held on the way, and however
long, that is one undo. A drag is one; a run of wheel clicks that pauses for 400 ms is one.
There is no timer inside a flight: a long flight is one long step, because a pilot who flew
somewhere and wants to go back wants to go back to where they took off.

**Pace.** W A S D E Q move Eye and Look At together at 1.1 times the distance between them
a second (shift is four times that), the scale-free pace the inspection flight has. A
flight keeps that distance, so it keeps its pace; the wheel changes the distance, and is
the throttle. On the owner's rig, an offset of five metres cruises at 5.5 m/s.

**Origin and Heading.** As section 4, with three things settled:

- *Heading is read for its horizontal part only.* The frame turns about the vertical and
  never tilts. A camera following a subject up a ramp rises with it and keeps its horizon;
  and the gizmo's orbit, truck and flight are the same turn-about-the-vertical in the frame
  as in the world, so the gizmo needed no change at all. A frame that also pitches is a
  question for the owner if a shot wants it (it is a different parameter: an up vector).
- *The frame's forward is its −z*, the way a camera looks. The default camera (Eye 0, 0.5,
  3, Look At the origin) under a subject's position and heading sits three behind and half
  above it, looking where it goes: a chase camera with nothing typed.
- *No version bump and no migrate.* The Camera stays at definition version 1, as Geometry
  did for its transform (§T1588b): absent parameters resolve to their defaults and the
  defaults are the identity, float for float. A bump would mark every document with a
  camera as changed on load and force a regen of the 23 shipped examples that hold one, to
  move no stored value. Proved instead: 49 documents and 53 cameras pinned before the
  change, at three frames, identical after.

**A driven pose, three cases.** Eye and Look At all driven: no button, no gizmo, and
"Driven by expressions (Eye, Look At)."; on a Render framed by it, "Framed by camera_rig.
Driven by expressions (Eye, Look At).". Some channels driven: it flies on the rest, and
says "Stays driven: Eye x (Expression)." on the tile toggle's hover, the viewer button's,
and the readout while flying. The rig on Origin and Heading: everything a flight writes is
free, and it flies.

**The tile's toggle** holds 12 px below the zoom where it would be smaller (75 %). The
sentence a camera-less tile carries is not floored: it would be wider than its tile.

Not built here, as row text:

- **Fly a driven rig by displacing it.** A camera whose Eye and Look At are all driven and
  whose Origin is free could still be flown by writing ORIGIN: a translation added to the
  rig (Blender's parent lock, "the root parent is transformed rather than the camera"). It
  would make the owner's file flyable as it stands, for translation only (no orbit: Origin
  cannot turn the rig about its own target). Left out because it is a second write target
  with a smaller gesture set, and the sentence would have to explain which.
- **A frame that pitches and banks** (an Up or a full orientation beside Heading).
- **The editor queues a gesture's writes one behind another**, so on a loaded machine the
  document trails a flight for a moment after the key comes up (seen in the GPU lane with
  six specs in parallel). True of every drag through `ParameterEditor`; unmeasured.
- **The viewer's bar squeezes its Display picker** when the fly button's name is long.

## 9. A frame that pitches (§T1671b), designed and then built

**Why now.** The owner's `camera_rig` is a table of 25 directed shots whose eye and aim are
expressions. Moved onto section 8's frame it is Origin = the directed eye, Heading = aim
minus eye, Eye 0, 0, 0. But that frame only turns about the vertical, so the aim's height and
distance have to stay in Look At as expressions: two of the six channels a flight writes are
driven. E and Q then tilt the view instead of raising it, and W does not carry the aim.
With a frame that also pitches, the aim is straight down the frame's own forward, Look At is
0, 0, minus the distance as plain numbers, and all six channels are free.

**What the reference tools do** (from section 2's reading; "read" as there).

- TouchDesigner parents a camera to a COMP's WHOLE transform: "If a COMP is wired to another
  COMP through its top connector, then that COMP is its transform parent" (`3D_Parenting`,
  read). Aiming is separate: Look At, with an Up Vector that "should not be parallel to the
  look at direction" (`Camera_COMP`, read). The pole is the user's to avoid.
- Notch: a camera inherits "the transformation values of parent nodes", and can take the
  position only ("rotation and scale will be ignored"); a Target Node input turns it "to
  always direct the z axis towards the input" (`nodes/cameras/`, read). That Notch's parent
  has a rotation order is the lead's statement; I did not read the page that says so.

Both give the full orientation and both keep "position only" as the other choice. Neither
states a rule for the pole; this one does.

**The choice: Frame, on the Camera. Level (the default) or Aimed.**

| Frame | What Heading does | For |
|---|---|---|
| Level | Section 8's: only its horizontal part is read. The frame turns about the vertical and never tilts. | A chase camera: it follows where the subject goes and keeps its own horizon and height offset. |
| Aimed | Read whole. The frame's forward (its −z) IS Heading; its up is the world's up made perpendicular to that. | A directed shot: Heading is where the camera looks, and Look At 0, 0, −d is "d along the shot". |

Level is the default, so no saved camera moves and the node stays at version 1 (the pins
again: 49 documents, identical). An enum and not a second vector, because the two readings
of ONE Heading are the whole difference, and a document says which it means.

**The pole, stated.** A Heading within about 2.6° of straight up or down (|y| over 0.999 of
its length) has no "world up made perpendicular". The frame then takes world +z as its up
reference: exactly the rule the camera's own view already has for a view that steep
(`guardedRolledUp`), so the frame's axes and the picture's axes agree there too. A Heading
of no length is no heading in either mode. Nothing is NaN, and nothing is remembered from
the frame before: the rule is a function of this frame's Heading alone.

**Bank: not in this slice, and the reason is the picture.** An Up vector beside Heading
would tilt the FRAME, so offsets to the side would bank with the subject. It would not bank
the PICTURE: the payload a Render reads is a world Eye, a world Look At and Roll, and the
horizon is built from the world's up. A parameter called Up that leaves the horizon level is
a control that looks dead (§V880's family). Doing it honestly means the frame's up becomes
the view's up reference, which is a change to the camera payload and every consumer of it
(the Render, the tile, the projector's shared guard, Camera Blur's basis). Until then Roll
banks the picture and is drivable. Row text below.

**The gestures in an Aimed frame.** One rule: THE GESTURES KEEP THEIR WORLD MEANING, and what
they write is still the offset in the frame.

- *Orbit* is a turntable about the WORLD's vertical through Look At, as on every other tile:
  a sideways drag carries the eye round the aim at the height it had, and the up-down clamp
  is against the world's poles. About the frame's own up it would be a tilted circle (the
  eye rising on one side of a diving shot and sinking on the other), and the clamp would let
  the view pass through the world's vertical, where the picture flips.
- *Truck* (shift-drag) slides Eye and Look At along the picture's right and up.
- *W A S D* run along the view and the picture's right. *E and Q* rise and fall along THE
  PICTURE'S UP, which is what they mean in the inspection flight and everywhere else here:
  the camera's own up, perpendicular to where it looks. For a directed shot looking down
  its frame's forward that is the frame's up; it is the world's up only for a level view.
- *The wheel* dollies along the view.

So the store is told one more thing about a pose: which way the world's up points in the
pose's own coordinates (0, 1, 0 for every Level frame and every node with no frame, where
nothing changes). It is read with the pose at the start of a gesture (§V657), so on a rig
whose Heading is turning the axis is the one the gesture began with.

**Costs.** One enum on the Camera's definition; the frame's composition gains its up axis;
the gizmo's orbit and truck gain a second form about a given axis (the form about y is left
exactly as it was). Values only: an Aimed rig animates as a uniform write.

**Left out, as row text.**

- **A frame that banks: an Up beside Heading, read when Aimed, and the view's up reference
  with it** (the payload carries an up; the Render, the tile, the projector guard and Camera
  Blur read it), so a banked frame banks the picture. Until then, Roll.
- **A gesture on a rig whose Heading turns while it is dragged** uses the world-up axis the
  gesture started with; re-reading the frame per pointer event would be exact.

**As built (2026-10-06, after section 10).** The Frame is read in the one function the
payload and section 10's channels are built by, so a reader of `chan.eyeX` changes nothing
when a camera opts in: a pass that rebuilds the view ray from the channels draws the same
bytes for a directed shot whose Heading climbs as for the same pose written plainly (Dawn).
The Frame's own description says the two gesture rulings, where the owner chooses it. The
store's turntable and truck have a second form about a given axis, taken only when the pose
says the world's up is not its +y (an Aimed frame whose Heading climbs or dives); a pose
with no such axis runs the lines it always ran. Held in the app on the consumer's shape:
nothing stays driven, W runs down the directed view, E rises along the picture's up, a
sideways drag keeps the eye's world height, each is one undo step.

## 10. The composed pose, read by an expression (§T1674b)

**The hole.** Section 4 said every consumer of the payload gets world values and none
changes. An expression reading `op('camera_rig').par.eye` is a consumer that is not of the
payload: it gets the parameter, which since section 8 is the offset. A texture pass takes no
camera, so a pass that turns a pixel back into a view ray (lit air, a focus by distance, a
reflection) reads the node that way. The first consumer to put its rig on Origin and Heading
lost its haze within the hour, with nothing said, and worked through it by saying the
engine's composition a second time in its own expressions. Section 9's Aimed frame would
have broken that second saying for any camera that opts in. This landed before it.

**What the reference tools give.**

- TouchDesigner, two ways. A member of the object: `worldTransform`, "The current world
  transform of the Object" (`ObjectCOMP_Class`, read), computed from the parameters and
  the parent chain, read in any expression. And an operator: "The Object CHOP compares two
  objects and outputs channels containing their raw or relative positions and orientations",
  with Measurements of Position, Rotation, Bearing and Distance (`Object_CHOP`, read): a
  node, so it has a wire.
- Notch: the Extractor modifier "extracts a single numerical value from another node", and
  "for some nodes, there are properties available specifically for the Extractor" (the
  search listing of `nodes/modifiers/extractor`; the page's body would not load, so which
  values a Camera offers is NOT read). A node with a wire, like the Object CHOP.

Both tools read the world pose from the engine. Neither asks the author to compose it.

**The ruling: the address is a channel, the vehicle is the reader.**

`op('camera_rig').chan.eyeX`. The camera publishes: `eyeX/Y/Z`, `aimX/Y/Z`,
`forwardX/Y/Z`, `rightX/Y/Z`, `upX/Y/Z` (the picture's own basis, the guarded up, Roll
included: `cameraBasis`, what the Render's view is built on), `distance` (eye to aim) and
`fov`. Eye and aim come from the one function the payload is built by
(`composedCameraPose` in `scene.ts`), so there is one composition.

Channels by the value graph were the starting position, and I checked that vehicle first. A
node enters the value graph by declaring `valueEvaluate`. For a Camera that would:

- turn its tile into a plot (`publishesValueChannels` decides plot or picture);
- stop an unused camera being reported dead (`isValueSourceDefinition`);
- resolve the camera's parameters a second time every frame, read or not (the consumer's
  rig is a table of 25 shots in expressions);
- make the read need a channel resolver, which a structural compile, a panel and a build
  script do not have. They would get the retained number, and "no channel resolver" as an
  info.

So the channels are declared on the definition (`parameterChannels`: the names, the
parameters they are composed from, one pure function of the resolved values) and read by the
ONE reader of `op()`, as the `.par` read is: off the same per-frame resolve of the target,
through the same cycle guard, in every context a parameter can be read in. Measured by
reading: a frame that reads seventeen channels of one camera resolves that camera once (the
reader's memo, T1172). Unread, it costs nothing. This is TouchDesigner's member, not its
Object CHOP: there is no wire out of the camera. A Constant whose Value is the read is the
wire, and then it is a value node like any other (a Lag can follow it).

**A camera inside a component.** Its siblings inside read it by name, as they read its
parameters. From outside, `op('<instance>').chan.<c>` reaches only what the component
exposes on a value output (T1485b), so a component that wants its camera's pose read outside
publishes it through a Constant on an Out. Not built further, and no test drives the inside
read.

**A texture pass that takes a Camera input** (the peer's second form: eye, forward, right,
up and fov arrive as uniforms without an expression each). Not needed once the channels
exist: seventeen expressions do the job and the numbers are the same. It is a convenience
with a real cost (a camera port on Custom WGSL and its multi form, reserved names in the
user's `struct Params`, the view-camera contract beside it), so it is its own row and
waits for a second consumer. Row text below.

**The finding.** A warning, `parameter.reference.notComposed`, class `advice` (the read
takes effect exactly as stored), on the READER, once per read:

> "wgsl_haze".eye.x reads op('camera_rig').par.eye.x, which is the offset in the frame its
> Origin and Heading make, not where the camera is in the world.
> Read op('camera_rig').chan.eyeX for where the camera is in the world.

The camera's definition decides (`insteadOf`), from what the node STORES: Origin or Heading
with a stored value that is not zero, or driven at all. A camera with no frame says nothing.
Across the shipped set: 112 documents, 46 findings, all 46 on the consumer's file (its second
saying of the composition), none anywhere else. The camera reading its own Eye is not asked.

One thing it cannot tell: a read that MEANS the offset (the consumer's "how far has the
flight pulled the camera from the directed shot" divides two offset lengths). It is told the
same thing and stays told. Row text below.

**Distances.** Read, then held where it matters:

- A frame is rigid, in both modes: the distance between the stored Eye and Look At IS the
  world distance. So the fly pace (1.1 times that distance a second) and the orbit's reach
  are right as they are. `camera-channels.test.ts` holds `distance` against the stored
  offsets at three moments of a moving rig.
- Camera Blur has no focus: it reads the payload's composed poses (and their motion) and a
  depth texture. Held on Dawn since slice 1e.
- The CRT Tube's Distance and Focus Offset are its own lens, not a Camera node.
- The consumer's focus scaled by hand is `chan.distance` now.

**Left out, as row text.**

- **A texture pass takes a Camera input**: Custom WGSL (and its multi form) gains a camera
  port; wired, the pass's uniforms carry the eye, the basis and the field of view from the
  payload. Waits for a second consumer: the channels do this job.
- **A read that means the offset** has no spelling the finding can tell from a mistake, so
  it is warned for as long as it stands. If a second document needs one: a third namespace
  beside `par` and `chan` for "as stored", or the finding learns to pass an expression that
  reads no world value of the same camera.
- **The channels in the lists that enumerate value bags**: the agent tool `get_channels`
  and the inspector's channel pickers read the value graph's bags, so a camera's channels
  are not in them. Completion in an expression field does offer them.

## 11. Look: an inspection orbit around a picture drawn through a camera (§T1732b), built 2026-11-06

**The ask.** The owner, building the PillarPreviz guest camera (Eye driven by expressions with a
sway): *"I definitely need to be able to move geometry viewers, camera viewers equally"*, without
losing the drivers, and on each node's own tile, not only in the viewer. Ctrl+Z is enough for the
editing mode.

**The ruling.** A picture drawn through a camera node has two cameras. LOOK is the default: view
only, never an edit, so it works on a driven camera. MOVE is the camera node's own pose (T692's
gizmo on the tile, §T970's lock in the viewer): every gesture is an edit that undo steps back.
Tiles show both as a pair in the corner (C, M); alt over a tile arms LOOK; the viewer's unlocked
drag looks, and "Fly" moves. No W A S D on tiles. "Set camera from this view" waits (T1735b).

**Why §3's cheap route does not hold for a Render.** §3 proposed cloning the draw passes and
writing the clone's camera uniforms. A Render derives far more than `viewProjection` from its
camera: the eye, the view direction, the AO depth row and its projection, the half-height. An
override is a second copy of every one of those derivations, and copies drift.

**What was built instead: a second compile.** The editor sends a `look` sink while a look is moved
off its camera (arming costs nothing). The compiler splices a nameless clone of the renderer into
the flat graph (`<id>~look`, every edge into the renderer copied onto it), so the clone is the
Render's own code with its own scratch. Only the payload on its camera input differs: the live
camera's, with the eye and look-at moved by the orbit (`orbitPose`, deltas over the pose, so an
identity look is the camera, byte for byte on Dawn). The orbit is read only at a frame; the values
lane re-runs the clone every frame, so a driven camera's sway carries into the look. Nothing reads
the clone's target but the tile and the viewer, so the Render's own output is byte-identical with
a look on (`compiler/look.gpu.test.ts`).

**How TouchDesigner and Notch compare** (from their known behaviour, not re-checked against
their documentation for this note). Both keep a viewer's camera apart from the scene camera:
TouchDesigner's node viewer tumbles a 3D COMP without touching the Camera COMP, and Notch's editor
view is not the render camera. §2 holds the sourced comparison for the free view. Loom's difference
is that the look lives on the node's own tile as well as in the viewer, and that a Render's tile
shows the real picture until somebody looks.

**What it costs.** While a look stands, the renderer draws twice, at full resolution (a cap is
T1736b). Starting and ending a look is one structural compile each.
