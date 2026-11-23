import type { AppSettings, ResourceSnapshot, StorageUsageBreakdown } from '../../types/domain';
import { computeVaultNamespaceBytes } from '../storage/database';
import { resolveEffectiveHeavyConcurrency } from '../orchestrator/scheduler';

interface BatteryManagerLike {
  level: number;
  charging: boolean;
}

interface NavigatorWithDeviceApis extends Navigator {
  deviceMemory?: number;
  getBattery?: () => Promise<BatteryManagerLike>;
}

export class ResourceManager {
  private activeModels = new Map<string, number>(); // modelId -> allocated MB

  registerLoadedModel(modelId: string, memoryMb: number) {
    this.activeModels.set(modelId, memoryMb);
  }

  unloadModel(modelId: string) {
    this.activeModels.delete(modelId);
  }

  unloadAllModels() {
    this.activeModels.clear();
  }

  getActiveModelMemoryMb(): number {
    let total = 0;
    for (const mb of this.activeModels.values()) {
      total += mb;
    }
    return total;
  }

  async captureSnapshot(settings: AppSettings): Promise<ResourceSnapshot> {
    const nav = typeof navigator !== 'undefined' ? (navigator as NavigatorWithDeviceApis) : null;

    // 1. Device memory (real Navigator.deviceMemory if exposed by Chromium/Android WebView)
    const deviceMemoryGb =
      nav && typeof nav.deviceMemory === 'number' && Number.isFinite(nav.deviceMemory)
        ? nav.deviceMemory
        : null;

    // 2. Local storage breakdown
    const namespaces = await computeVaultNamespaceBytes();
    let quotaBytes: number | null = null;
    let usageBytes: number | null = null;
    let availableBytes: number | null = null;
    let measurementSource: StorageUsageBreakdown['measurementSource'] = 'vault_accounting_only';

    if (nav && nav.storage && typeof nav.storage.estimate === 'function') {
      try {
        const estimate = await nav.storage.estimate();
        if (typeof estimate.quota === 'number') quotaBytes = estimate.quota;
        if (typeof estimate.usage === 'number') usageBytes = estimate.usage;
        if (quotaBytes !== null && usageBytes !== null) {
          availableBytes = Math.max(0, quotaBytes - usageBytes);
        }
        measurementSource = 'navigator_storage_api';
      } catch {
        measurementSource = 'vault_accounting_only';
      }
    }

    // 3. Battery status when supported
    let batteryLevelPercent: number | null = null;
    let batteryCharging: boolean | null = null;
    let batterySupported = false;

    if (nav && typeof nav.getBattery === 'function') {
      try {
        const battery = await nav.getBattery();
        batteryLevelPercent = Math.round(battery.level * 100);
        batteryCharging = Boolean(battery.charging);
        batterySupported = true;
      } catch {
        batterySupported = false;
      }
    }

    // 4. Effective heavy concurrency policy
    const maxHeavyConcurrency = resolveEffectiveHeavyConcurrency({
      maxConcurrentHeavyModels: settings.maxConcurrentHeavyModels,
      maxConcurrentLightweightTasks: 3,
      availableRamGb: deviceMemoryGb,
      allowTwoHeavyOnlyAboveGb: 12,
    });

    // 5. Evaluate scheduler safety state
    let schedulerStatus: ResourceSnapshot['schedulerStatus'] = 'nominal';
    if (
      settings.pauseOnLowBattery &&
      batteryLevelPercent !== null &&
      !batteryCharging &&
      batteryLevelPercent <= settings.lowBatteryThresholdPercent
    ) {
      schedulerStatus = 'paused_low_resources';
    } else if (availableBytes !== null && availableBytes < 150 * 1024 * 1024) {
      schedulerStatus = 'paused_low_resources';
    } else if (deviceMemoryGb !== null && deviceMemoryGb <= 4) {
      schedulerStatus = 'constrained';
    }

    return {
      deviceMemoryGb,
      memoryMeasurementSource:
        deviceMemoryGb !== null ? 'navigator_deviceMemory' : 'unavailable_in_browser',
      activeHeavyModelCount: this.activeModels.size,
      activeModelMemoryMb: this.getActiveModelMemoryMb(),
      maxHeavyConcurrency,
      storage: {
        quotaBytes,
        usageBytes,
        availableBytes,
        namespaces,
        measurementSource,
      },
      batteryLevelPercent,
      batteryCharging,
      batterySupported,
      thermalState: 'unavailable_in_web_runtime',
      schedulerStatus,
      capturedAt: new Date().toISOString(),
    };
  }
}

export const resourceManager = new ResourceManager();
