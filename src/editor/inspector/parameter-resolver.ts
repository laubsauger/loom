/**
 * The inspector's parameter read path — which is now the ONLY parameter read path
 * (§V61, T168, closing B8).
 *
 * This file used to hold the implementation while `src/compiler/validate.ts` held a
 * second one. They drifted: the display→linear colour decode (T148, §V56) landed here
 * and not there, so the inspector showed the corrected colour and the GPU rendered the
 * uncorrected one. §V61 says there is one read path, so the implementation was promoted
 * into `src/domain/parameters/resolve.ts`, where the compiler (Node, worker-ready) and
 * the inspector (browser) can both reach it.
 *
 * What stays here is this re-export, so editor code keeps importing the resolver from
 * the layer it lives in. There is no implementation in this file and there must never be
 * one again — a second copy is exactly the bug B8 records.
 */

export {
  resolveParameter,
  resolveParameterSchema,
  resolveParameters,
} from "@domain/parameters/resolve.ts";
export type {
  ParameterDriver,
  ParameterDriverContext,
  ParameterSource,
  ResolveParametersOptions,
  ResolvedParameter,
  ResolvedParameters,
} from "@domain/parameters/resolve.ts";
