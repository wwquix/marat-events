import "server-only";

import {
  assertStagingServerEnvironment,
  inspectServerEnvironment,
  type DeploymentTarget,
  type EnvironmentInspection,
} from "./environment-policy";

export function inspectCurrentServerEnvironment(target: DeploymentTarget): EnvironmentInspection {
  return inspectServerEnvironment(target, process.env);
}

export function assertCurrentStagingServerEnvironment(): void {
  assertStagingServerEnvironment(process.env);
}
