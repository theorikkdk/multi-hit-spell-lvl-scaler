import { formatLocalization, localize } from "../i18n.mjs";
import { debug, getSpellConfig, warn } from "../module.mjs";
import { createCastContext, getCastContext } from "../runtime/cast-context.mjs";
import { promptExtraHitResolution } from "./extra-hit-prompt.mjs";
import { computeExtraHitCount } from "./extra-hit-count.mjs";
import {
  resolveNextExtraHit,
  waitForMidiWorkflowCompletion
} from "./extra-hit-executor.mjs";

const PRE_CAST_GUARD_HOOK = "dnd5e.preUseActivity";
const CAST_DETECTOR_HOOK = "dnd5e.postUseActivity";
const MODULE_ID = "multi-hit-spell-lvl-scaler";

let castDetectorRegistered = false;

function normalizeNonNegativeInteger(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(numericValue));
}

function cloneData(data) {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(data);
  }

  return JSON.parse(JSON.stringify(data));
}

function summarizeDocument(document, fallbackType = "document") {
  if (!document) {
    return null;
  }

  return {
    id: typeof document.id === "string" ? document.id : null,
    uuid: typeof document.uuid === "string" ? document.uuid : null,
    name: typeof document.name === "string" ? document.name : "",
    type: typeof document.type === "string" ? document.type : fallbackType
  };
}

function summarizeToken(token) {
  const tokenDocument = token?.document ?? token;

  if (!tokenDocument) {
    return null;
  }

  return {
    id: typeof tokenDocument.id === "string" ? tokenDocument.id : null,
    uuid: typeof tokenDocument.uuid === "string" ? tokenDocument.uuid : null,
    name: typeof tokenDocument.name === "string" ? tokenDocument.name : "",
    sceneId: typeof tokenDocument.parent?.id === "string" ? tokenDocument.parent.id : null,
    sceneName: typeof tokenDocument.parent?.name === "string" ? tokenDocument.parent.name : ""
  };
}

function clonePlainObject(data) {
  if (foundry?.utils?.deepClone) {
    return foundry.utils.deepClone(data ?? {});
  }

  return cloneData(data ?? {});
}

function notifyWarn(message, details = undefined) {
  warn(message, details);
  ui.notifications?.warn?.(message);
}

function createTargetSnapshot(token) {
  const tokenDocument = token?.document ?? token;

  if (!tokenDocument?.uuid) {
    return null;
  }

  return {
    tokenId: typeof tokenDocument.id === "string" ? tokenDocument.id : null,
    tokenUuid: tokenDocument.uuid,
    actorUuid: typeof tokenDocument.actor?.uuid === "string" ? tokenDocument.actor.uuid : null,
    sceneId: typeof tokenDocument.parent?.id === "string" ? tokenDocument.parent.id : null,
    name: typeof tokenDocument.name === "string"
      ? tokenDocument.name
      : (typeof tokenDocument.actor?.name === "string" ? tokenDocument.actor.name : "")
  };
}

function getCurrentUserTargetSnapshots() {
  return Array.from(game?.user?.targets ?? [], (token) => createTargetSnapshot(token)).filter(Boolean);
}

function resolveTokenObjectFromSnapshot(snapshot) {
  if (!snapshot?.tokenId) {
    return null;
  }

  return canvas?.tokens?.get?.(snapshot.tokenId)
    ?? game.scenes?.get?.(snapshot.sceneId ?? null)?.tokens?.get?.(snapshot.tokenId)?.object
    ?? null;
}

async function applyUserTargetSnapshots(targetSnapshots = []) {
  const snapshots = Array.isArray(targetSnapshots) ? targetSnapshots : [];

  if (typeof game?.user?.updateTokenTargets === "function") {
    await game.user.updateTokenTargets(snapshots.map((snapshot) => snapshot.tokenId).filter(Boolean));
    return {
      ok: true,
      source: "game.user.updateTokenTargets"
    };
  }

  const currentTargets = Array.from(game?.user?.targets ?? []);

  for (const token of currentTargets) {
    if (typeof token?.setTarget === "function") {
      token.setTarget(false, {
        user: game.user,
        releaseOthers: false,
        groupSelection: true
      });
    }
  }

  for (const [index, snapshot] of snapshots.entries()) {
    const tokenObject = resolveTokenObjectFromSnapshot(snapshot);

    if (typeof tokenObject?.setTarget !== "function") {
      return {
        ok: false,
        reason: "selected-target-unresolved",
        details: {
          targetSnapshot: snapshot
        }
      };
    }

    tokenObject.setTarget(true, {
      user: game.user,
      releaseOthers: index === 0,
      groupSelection: true
    });
  }

  return {
    ok: true,
    source: "token.setTarget"
  };
}

function createTargetDescriptorFromSnapshot(snapshot) {
  if (!snapshot?.actorUuid) {
    return null;
  }

  const tokenObject = resolveTokenObjectFromSnapshot(snapshot);
  const actor = tokenObject?.actor ?? tokenObject?.document?.actor ?? null;

  return {
    name: snapshot.name ?? actor?.name ?? "",
    img: actor?.img ?? actor?.prototypeToken?.texture?.src ?? "",
    uuid: snapshot.actorUuid,
    ac: actor?.statuses?.has?.("coverTotal") ? null : (actor?.system?.attributes?.ac?.value ?? null)
  };
}

function setUsageMessageTargets(messageConfig, targetSnapshots = []) {
  const descriptors = targetSnapshots
    .map((snapshot) => createTargetDescriptorFromSnapshot(snapshot))
    .filter(Boolean);

  foundry.utils.setProperty(messageConfig, "data.flags.dnd5e.targets", descriptors);
}

function forceSingleTargetUsageConfig(usageConfig, targetSnapshot) {
  const tokenObject = resolveTokenObjectFromSnapshot(targetSnapshot);
  const targetUuids = [targetSnapshot?.tokenUuid].filter(Boolean);
  const targetIds = [targetSnapshot?.tokenId].filter(Boolean);

  usageConfig.targets = tokenObject ? new Set([tokenObject]) : new Set();
  usageConfig.targetIds = targetIds;
  usageConfig.targetUuids = targetUuids;
  usageConfig.midiOptions = {
    ...clonePlainObject(usageConfig.midiOptions ?? {}),
    targetUuids,
    targetsToUse: tokenObject ? new Set([tokenObject]) : new Set(),
    workflowOptions: {
      ...clonePlainObject(usageConfig.midiOptions?.workflowOptions ?? {}),
      targetConfirmation: "none"
    }
  };

  return usageConfig;
}

function resolveItem(activity, actor) {
  return actor?.items?.get?.(activity?.item?.id)
    ?? activity?.item
    ?? null;
}

function resolveActivity(activity, item) {
  return item?.system?.activities?.get?.(activity?.id)
    ?? activity
    ?? null;
}

function resolveConfiguredHitActivity(activity, item, spellConfig = {}) {
  const configuredHitActivityId = (typeof spellConfig?.hitActivityId === "string" && spellConfig.hitActivityId)
    ? spellConfig.hitActivityId
    : (typeof spellConfig?.extraActivityId === "string" && spellConfig.extraActivityId)
      ? spellConfig.extraActivityId
      : (typeof spellConfig?.baseActivityId === "string" && spellConfig.baseActivityId)
        ? spellConfig.baseActivityId
        : null;

  return item?.system?.activities?.get?.(configuredHitActivityId)
    ?? resolveActivity(activity, item);
}

function resolveToken(activity, actor) {
  const activeToken = actor?.getActiveTokens?.()?.[0] ?? null;

  if (activeToken) {
    return {
      token: activeToken,
      source: "actor.getActiveTokens()[0]"
    };
  }

  if (actor?.token) {
    return {
      token: actor.token,
      source: "actor.token"
    };
  }

  if (activity?.token) {
    return {
      token: activity.token,
      source: "activity.token"
    };
  }

  return {
    token: null,
    source: "unresolved"
  };
}

function resolveSpellLevel(activity, item, actor, usageConfig = {}) {
  const spellSlot = usageConfig?.spell?.slot;

  if (typeof spellSlot === "number") {
    return {
      value: normalizeNonNegativeInteger(spellSlot, null),
      source: "usageConfig.spell.slot:number"
    };
  }

  if (typeof spellSlot === "string" && spellSlot) {
    const actorSpellLevel = normalizeNonNegativeInteger(actor?.system?.spells?.[spellSlot]?.level, null);

    if (actorSpellLevel !== null) {
      return {
        value: actorSpellLevel,
        source: `actor.system.spells.${spellSlot}.level`
      };
    }

    const parsedLevel = normalizeNonNegativeInteger(spellSlot.match(/\d+/)?.[0], null);

    if (parsedLevel !== null) {
      return {
        value: parsedLevel,
        source: "usageConfig.spell.slot:string"
      };
    }
  }

  const itemLevel = normalizeNonNegativeInteger(item?.system?.level, null);
  const scaling = normalizeNonNegativeInteger(usageConfig?.scaling, null);

  if ((itemLevel !== null) && (scaling !== null)) {
    return {
      value: itemLevel + scaling,
      source: "item.system.level + usageConfig.scaling"
    };
  }

  if (itemLevel !== null) {
    return {
      value: itemLevel,
      source: "item.system.level"
    };
  }

  const activityLevel = normalizeNonNegativeInteger(activity?.spell?.level, null);

  if (activityLevel !== null) {
    return {
      value: activityLevel,
      source: "activity.spell.level"
    };
  }

  return {
    value: null,
    source: "unresolved"
  };
}

function shouldHandleActivity(item, activity, spellConfig) {
  if (!item || item.type !== "spell") {
    return false;
  }

  if (!spellConfig?.enabled) {
    return false;
  }

  const acceptedActivityIds = [
    spellConfig?.hitActivityId,
    spellConfig?.baseActivityId
  ].filter((activityId) => typeof activityId === "string" && activityId);

  if (!acceptedActivityIds.length) {
    return false;
  }

  if (acceptedActivityIds.length && !acceptedActivityIds.includes(activity?.id)) {
    return false;
  }

  return true;
}

function resolveUserId(results) {
  const messageAuthor = results?.message?.author;

  if (typeof messageAuthor === "string" && messageAuthor) {
    return messageAuthor;
  }

  if (typeof messageAuthor?.id === "string" && messageAuthor.id) {
    return messageAuthor.id;
  }

  if (typeof game?.user?.id === "string" && game.user.id) {
    return game.user.id;
  }

  return null;
}

function buildControlledBaseUsageConfig(sourceUsageConfig = {}) {
  const usageConfig = {
    ...sourceUsageConfig,
    spell: clonePlainObject(sourceUsageConfig?.spell ?? {}),
    concentration: clonePlainObject(sourceUsageConfig?.concentration ?? {}),
    subsequentActions: false,
    [MODULE_ID]: {
      ...clonePlainObject(sourceUsageConfig?.[MODULE_ID] ?? {}),
      isControlledInitialBase: true,
      skipCastDetection: true
    }
  };

  if (foundry.utils.getType(sourceUsageConfig?.consume) === "Object") {
    usageConfig.consume = clonePlainObject(sourceUsageConfig.consume);
  }

  delete usageConfig.targets;
  delete usageConfig.targetIds;
  delete usageConfig.targetUuids;

  return usageConfig;
}

function buildControlledBaseDialogConfig(sourceDialogConfig = {}) {
  return {
    ...sourceDialogConfig,
    configure: false,
    options: clonePlainObject(sourceDialogConfig?.options ?? {})
  };
}

function buildControlledBaseMessageConfig(targetSnapshot, sourceMessageConfig = {}, metadata = {}) {
  const messageConfig = {
    create: sourceMessageConfig?.create ?? true,
    data: clonePlainObject(sourceMessageConfig?.data ?? {})
  };

  setUsageMessageTargets(messageConfig, [targetSnapshot]);
  foundry.utils.setProperty(messageConfig, `data.flags.${MODULE_ID}.initialAllocation`, {
    ...metadata,
    target: cloneData(targetSnapshot)
  });

  return messageConfig;
}

async function resolveConfiguredInitialCast(activity, usageConfig = {}, dialogConfig = {}, messageConfig = {}) {
  const actor = activity?.actor ?? activity?.item?.actor ?? null;
  const item = resolveItem(activity, actor);
  const spellConfig = item ? getSpellConfig(item) : null;
  const controlledActivity = resolveConfiguredHitActivity(activity, item, spellConfig);

  if (!shouldHandleActivity(item, controlledActivity, spellConfig)) {
    return;
  }

  const originalTargetSnapshots = getCurrentUserTargetSnapshots().map((snapshot) => cloneData(snapshot));
  let finalRestoreTargetSnapshots = originalTargetSnapshots;
  const manualUsageConfig = buildControlledBaseUsageConfig(usageConfig);
  const manualDialogConfig = buildControlledBaseDialogConfig(dialogConfig);

  try {
    const requiresConfigurationDialog = dialogConfig?.configure
      && (typeof controlledActivity?._requiresConfigurationDialog === "function")
      && controlledActivity._requiresConfigurationDialog(manualUsageConfig);

    if (requiresConfigurationDialog) {
      try {
        await dialogConfig.applicationClass.create(
          controlledActivity,
          manualUsageConfig,
          manualDialogConfig.options
        );
      } catch {
        return;
      }
    }

    const initialTargetSnapshots = getCurrentUserTargetSnapshots().map((snapshot) => cloneData(snapshot));
    const initialTargetCount = initialTargetSnapshots.length;
    const spellLevel = resolveSpellLevel(controlledActivity, item, actor, manualUsageConfig);
    const hitSummary = computeExtraHitCount({
      item,
      spellConfig,
      castLevel: spellLevel.value
    });
    const totalHits = Math.max(1, normalizeNonNegativeInteger(hitSummary?.totalHits, 1) ?? 1);

    if (initialTargetCount < 1) {
      notifyWarn(formatLocalization(
        "Notifications.ConfigTargetRange",
        { totalHits },
        "Select between 1 and {totalHits} target(s) before casting this configured spell."
      ));

      debug("Blocked configured spell cast because no target was selected.", {
        hook: PRE_CAST_GUARD_HOOK,
        item: summarizeDocument(item, "item"),
        activity: summarizeDocument(controlledActivity, "activity"),
        spellLevel,
        hitSummary,
        totalHits
      });

      return;
    }

    if (initialTargetCount > totalHits) {
      notifyWarn(formatLocalization(
        "Notifications.ConfigTooManyTargets",
        {
          selectedCount: initialTargetCount,
          totalHits
        },
        "You selected {selectedCount} target(s), but this cast only provides {totalHits} hit(s). Reduce your selection and try again."
      ));

      debug("Blocked configured spell cast because selected targets exceed the total hits available.", {
        hook: PRE_CAST_GUARD_HOOK,
        item: summarizeDocument(item, "item"),
        activity: summarizeDocument(controlledActivity, "activity"),
        spellLevel,
        hitSummary,
        initialTargetCount,
        totalHits
      });

      return;
    }

    const firstTargetSnapshot = initialTargetSnapshots[0];
    finalRestoreTargetSnapshots = [cloneData(firstTargetSnapshot)];
    const firstSelectionResult = await applyUserTargetSnapshots([firstTargetSnapshot]);

    if (!firstSelectionResult.ok) {
      notifyWarn(localize("Notifications.InitialTargetPrepareFailed", "The initial target could not be prepared for a controlled single-target cast."));

      debug("Blocked controlled initial cast because the first target could not be selected cleanly.", {
        hook: PRE_CAST_GUARD_HOOK,
        activity: summarizeDocument(controlledActivity, "activity"),
        firstTargetSnapshot,
        firstSelectionResult
      });

      return;
    }

    const baseResults = await controlledActivity.use(
      forceSingleTargetUsageConfig(manualUsageConfig, firstTargetSnapshot),
      manualDialogConfig,
      buildControlledBaseMessageConfig(firstTargetSnapshot, messageConfig, {
        totalHits,
        initialTargetCount,
        hitIndex: 1
      })
    );
    const baseCompletionResult = await waitForMidiWorkflowCompletion(baseResults, {
      contextId: null,
      target: cloneData(firstTargetSnapshot)
    });

    if (!baseCompletionResult.ok) {
      debug("Timed out waiting for Midi-QOL workflow completion before resolving the next controlled initial hit.", baseCompletionResult);
    }

    if (!baseResults) {
      debug("Controlled initial cast did not complete and no hit context was created.", {
        hook: PRE_CAST_GUARD_HOOK,
        item: summarizeDocument(item, "item"),
        activity: summarizeDocument(controlledActivity, "activity"),
        initialTargetCount,
        totalHits
      });

      return;
    }

    const tokenResolution = resolveToken(controlledActivity, actor);
    let castContext = createCastContext({
      activity: controlledActivity,
      actor,
      item,
      token: tokenResolution.token,
      spellConfig,
      usageConfig: manualUsageConfig,
      spellLevel: spellLevel.value,
      extraHitSummary: hitSummary,
      resolvedHitCount: 1,
      results: baseResults,
      userId: resolveUserId(baseResults),
      createdFrom: PRE_CAST_GUARD_HOOK
    });

    debug("Resolved first hit from the configured total-hit pool.", {
      hook: PRE_CAST_GUARD_HOOK,
      contextId: castContext?.id ?? null,
      item: summarizeDocument(item, "item"),
      activity: summarizeDocument(controlledActivity, "activity"),
      actor: summarizeDocument(actor, "actor"),
      token: summarizeToken(tokenResolution.token),
      tokenSource: tokenResolution.source,
      spellLevel,
      totalHits,
      initialTargetCount,
      hitsRemaining: castContext?.hitsRemaining ?? 0
    });

    for (const targetSnapshot of initialTargetSnapshots.slice(1)) {
      if (!castContext?.id) {
        break;
      }

      const nextHitResult = await resolveNextExtraHit(castContext.id, {
        targetSnapshot,
        restoreTargetSnapshots: [cloneData(targetSnapshot)],
        event: manualUsageConfig.event
      });

      if (!nextHitResult.ok) {
        debug("Stopped controlled initial hit allocation before all selected targets were resolved.", {
          hook: PRE_CAST_GUARD_HOOK,
          contextId: castContext.id,
          targetSnapshot,
          nextHitResult
        });
        break;
      }

      finalRestoreTargetSnapshots = [cloneData(targetSnapshot)];
      castContext = nextHitResult.context ?? getCastContext(castContext.id) ?? null;
    }

    const remainingContext = castContext?.id ? getCastContext(castContext.id) : null;

    if (remainingContext?.resolutionMode === "manual"
      && (!remainingContext.userId || (remainingContext.userId === game?.user?.id))) {
      promptExtraHitResolution(remainingContext.id);
    }
  } finally {
    const restoreResult = await applyUserTargetSnapshots(finalRestoreTargetSnapshots);

    if (!restoreResult.ok) {
      debug("Unable to restore the final single-target selection after controlled hit allocation.", {
        hook: PRE_CAST_GUARD_HOOK,
        item: summarizeDocument(item, "item"),
        activity: summarizeDocument(controlledActivity, "activity"),
        finalRestoreTargetSnapshots,
        restoreResult
      });
    }
  }
}

function onPreUseActivity(activity, usageConfig = {}, dialogConfig = {}, messageConfig = {}) {
  if (usageConfig?.[MODULE_ID]?.isExtraHit || usageConfig?.[MODULE_ID]?.isControlledInitialBase) {
    return true;
  }

  const actor = activity?.actor ?? activity?.item?.actor ?? null;
  const item = resolveItem(activity, actor);
  const spellConfig = item ? getSpellConfig(item) : null;

  if (!shouldHandleActivity(item, activity, spellConfig)) {
    return true;
  }

  debug("Blocked native configured spell cast and delegated to controlled mono-target allocation.", {
    hook: PRE_CAST_GUARD_HOOK,
    item: summarizeDocument(item, "item"),
    activity: summarizeDocument(activity, "activity"),
    selectedTargetCount: getCurrentUserTargetSnapshots().length
  });

  setTimeout(() => {
    void resolveConfiguredInitialCast(activity, usageConfig, dialogConfig, messageConfig);
  }, 0);

  return false;
}

function onPostUseActivity(activity, usageConfig = {}) {
  if (!usageConfig?.[MODULE_ID]?.skipCastDetection
    && !usageConfig?.[MODULE_ID]?.isExtraHit
    && !usageConfig?.[MODULE_ID]?.isControlledInitialBase) {
    return;
  }

  debug("Skipping passive cast detection for a module-controlled hit workflow.", {
    hook: CAST_DETECTOR_HOOK,
    activity: summarizeDocument(activity, "activity"),
    contextId: usageConfig?.[MODULE_ID]?.contextId ?? null
  });
}

export function registerCastDetector() {
  if (castDetectorRegistered) {
    return false;
  }

  Hooks.on(PRE_CAST_GUARD_HOOK, onPreUseActivity);
  Hooks.on(CAST_DETECTOR_HOOK, onPostUseActivity);
  castDetectorRegistered = true;

  debug("Registered cast detector hooks.", {
    hooks: [
      PRE_CAST_GUARD_HOOK,
      CAST_DETECTOR_HOOK
    ]
  });

  return true;
}
