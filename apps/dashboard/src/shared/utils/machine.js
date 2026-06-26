import { getConsistentMachineId } from "@9router/shared/utils/machineId";

// Get machine ID using node-machine-id with salt
export async function getMachineId() {
  return await getConsistentMachineId();
}
