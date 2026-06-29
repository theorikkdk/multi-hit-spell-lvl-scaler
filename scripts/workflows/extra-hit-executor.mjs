import { formatLocalization, localize } from "../i18n.mjs";
import {
  deleteCastContext,
  getCastContext,
  updateCastContext
} from "../runtime/cast-context.mjs";

const MODULE_ID = "multi-hit-spell-lvl-scaler";
const DEBUG_SETTING = "debug";
const MIDI_WORKFLOW_COMPLETION_TIMEOUT_MS = 8000;

function getModuleVersion() {
  return game?.modules?.get?.(MODULE_ID)?.version ?? "dev";
}

function getLogPrefix() {
  return `[${MODULE_ID} v${getModuleVersion()}]`;
}

function isDebugEnabled() {
  const settingId = `${MODULE_ID}.${DEBUG_SETTING}`;

  if (!game?.settings?.settings?.has(settingId)) {
    return false;
  }

  return Boolean(game.settings.get(MODULE_ID, DEBUG_SETTING));
}

function debug(...args) {
  if (!isDebugEnabled()) {
    return;
  }

  console.debug(`${getLogPrefix()}[debug]`, ...args);
}

function warn(...args) {
  console.warn(getLogPrefix(), ...args);
}

function info(...args) {
  console.info(getLogPrefix(), ...args);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function getContextTotalHits(context) {
  return Math.max(
    1,
    normalizeNonNegativeInteger(
      context?.totalHits ?? context?.extraHitsTotal,
      1
    ) ?? 1
  );
}

function getContextHitsRemaining(context) {
  return Math.min(
    getContextTotalHits(context),
    Math.max(
      0,
      normalizeNonNegativeInteger(
        context?.hitsRemaining ?? context?.extraHitsRemaining,
        0
      ) ?? 0
    )
  );
}

function summarizeToken(token) {
  const tokenDocument = token?.document ?? token;

  if (!tokenDocument) {
    return null;
  }

  return {
    id: typeof tokenDocument.id === "string" ? tokenDocument.id : null,
    uuid: typeof tokenDocument.uuid === "string" ? tokenDocument.uuid : null,
    name: typeof tokenDocument.name === "string" ? tokenDocument.name : ""
  };
}

function summarizeActivity(activity) {
  if (!activity) {
    return null;
  }

  return {
    id: typeof activity.id === "string" ? activity.id : null,
    uuid: typeof activity.uuid === "string" ? activity.uuid : null,
    name: typeof activity.name === "string" ? activity.name : "",
    type: typeof activity.type === "string" ? activity.type : ""
  };
}

function notifyWarn(message, details = undefined) {
  warn(message, details);
  ui.notifications?.warn?.(message);
}

function notifyInfo(message, details = undefined) {
  info(message, details);
  ui.notifications?.info?.(message);
}

function canCurrentUserManageContext(context) {
  if (!context?.userId) {
    return true;
  }

  return (game?.user?.id === context.userId) || Boolean(game?.user?.isGM);
}

function createTokenSnapshot(token) {
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
  return Array.from(game?.user?.targets ?? [], (token) => createTokenSnapshot(token)).filter(Boolean);
}

function getCurrentCanvasSceneId() {
  return canvas?.scene?.id ?? null;
}

async function resolveTokenDocumentFromSnapshot(snapshot) {
  if (!snapshot) {
    return null;
  }

  if (typeof snapshot.tokenUuid === "string" && snapshot.tokenUuid) {
    const tokenFromUuid = await fromUuid(snapshot.tokenUuid);

    if (tokenFromUuid) {
      return tokenFromUuid.document ?? tokenFromUuid;
    }
  }

  if (snapshot.sceneId && snapshot.tokenId) {
    return game.scenes?.get?.(snapshot.sceneId)?.tokens?.get?.(snapshot.tokenId) ?? null;
  }

  return null;
}

function resolveTokenObjectFromDocument(tokenDocument) {
  return tokenDocument?.object ?? tokenDocument ?? null;
}

async function applyUserTargetSnapshots(targetSnapshots = []) {
  const snapshots = Array.isArray(targetSnapshots) ? targetSnapshots : [];
  const activeSceneId = getCurrentCanvasSceneId();

  for (const snapshot of snapshots) {
    if (!snapshot?.tokenId) {
      return {
        ok: false,
        reason: "selected-target-unresolved",
        message: localize("Notifications.TargetUnresolved", "A selected target could no longer be resolved."),
        details: {
          targetSnapshot: snapshot
        }
      };
    }

    if (activeSceneId && snapshot.sceneId && (snapshot.sceneId !== activeSceneId)) {
      return {
        ok: false,
        reason: "selected-target-off-scene",
        message: localize("Notifications.TargetOffScene", "The selected target is no longer on the active scene."),
        details: {
          activeSceneId,
          targetSnapshot: snapshot
        }
      };
    }
  }

  if (typeof game?.user?.updateTokenTargets === "function") {
    await game.user.updateTokenTargets(snapshots.map((snapshot) => snapshot.tokenId));

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
    const tokenDocument = await resolveTokenDocumentFromSnapshot(snapshot);
    const tokenObject = tokenDocument?.object ?? tokenDocument ?? null;

    if (typeof tokenObject?.setTarget !== "function") {
      return {
        ok: false,
        reason: "selected-target-unresolved",
        message: localize("Notifications.TargetUnresolved", "A selected target could no longer be resolved."),
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

async function resolveContextDocuments(context) {
  const item = context?.itemUuid ? await fromUuid(context.itemUuid) : null;
  const actor = item?.actor ?? (context?.actorUuid ? await fromUuid(context.actorUuid) : null);
  const hitActivity = item?.system?.activities?.get?.(context?.hitActivityId ?? context?.extraActivityId ?? context?.baseActivityId) ?? null;

  return {
    item,
    actor,
    hitActivity
  };
}

function checkSingleTargetSupport(activity) {
  const templateType = activity?.target?.template?.type ?? "";

  if (templateType) {
    return {
      ok: false,
      reason: "template-targeting-not-supported",
      details: {
        templateType
      }
    };
  }

  return {
    ok: true,
    targetCount: normalizeNonNegativeInteger(activity?.target?.affects?.count, 1) ?? 1
  };
}

function resolveSelectedTargetSnapshot() {
  const currentTargets = getCurrentUserTargetSnapshots();

  if (!currentTargets.length) {
    return {
      ok: false,
      reason: "selected-target-missing",
      message: localize("Notifications.NextHitSelectOne", "Select exactly one target before resolving the next hit.")
    };
  }

  if (currentTargets.length > 1) {
    return {
      ok: false,
      reason: "selected-target-ambiguous",
      message: localize("Notifications.SingleHitTooManyTargets", "Only one target can be selected when resolving a single hit."),
      details: {
        currentTargets
      }
    };
  }

  return {
    ok: true,
    source: "game.user.targets.current",
    target: currentTargets[0]
  };
}

async function resolveTargetForExtraHit(options = {}) {
  if (options.targetSnapshot) {
    const tokenDocument = await resolveTokenDocumentFromSnapshot(options.targetSnapshot);

    if (!tokenDocument) {
      return {
        ok: false,
        reason: "selected-target-unresolved",
        message: localize("Notifications.TargetUnresolved", "A selected target could no longer be resolved."),
        details: {
          targetSnapshot: options.targetSnapshot
        }
      };
    }

    return {
      ok: true,
      source: "options.targetSnapshot",
      target: createTokenSnapshot(tokenDocument)
    };
  }

  return resolveSelectedTargetSnapshot();
}

function resolveTargetSnapshotsForRemainingExtraHits(context, options = {}) {
  const remaining = getContextHitsRemaining(context);
  const currentTargets = getCurrentUserTargetSnapshots().map((snapshot) => cloneData(snapshot));

  if (Array.isArray(options.targetSnapshots) && options.targetSnapshots.length) {
    const targets = options.targetSnapshots.map((snapshot) => cloneData(snapshot));

    if (targets.length === 1) {
      return {
        ok: true,
        source: "options.targetSnapshots.repeat",
        targets: Array.from({ length: remaining }, () => cloneData(targets[0])),
        restoreTargetSnapshots: currentTargets,
        distribution: "repeat-single"
      };
    }

    if (targets.length > remaining) {
      return {
        ok: false,
        reason: "selected-targets-exceed-remaining",
        message: formatLocalization(
          "Notifications.TooManyTargetsForRemainingHits",
          {
            selectedCount: targets.length,
            remaining
          },
          "You selected {selectedCount} target(s), but only {remaining} hit(s) remain. Reduce your selection and try again."
        ),
        details: {
          selectedCount: targets.length,
          remaining
        }
      };
    }

    return {
      ok: true,
      source: "options.targetSnapshots.sequence",
      targets,
      restoreTargetSnapshots: currentTargets,
      distribution: "one-per-target",
      selectedCount: targets.length
    };
  }

  if (options.targetSnapshot) {
    return {
      ok: true,
      source: "options.targetSnapshot.repeat",
      targets: Array.from({ length: remaining }, () => cloneData(options.targetSnapshot)),
      restoreTargetSnapshots: currentTargets,
      distribution: "repeat-single"
    };
  }

  if (!currentTargets.length) {
    return {
      ok: false,
      reason: "selected-target-missing",
      message: localize("Notifications.RemainingHitsSelectAtLeastOne", "Select at least one target before resolving the remaining hits.")
    };
  }

  if (currentTargets.length === 1) {
    return {
      ok: true,
      source: "game.user.targets.current.single",
      targets: Array.from({ length: remaining }, () => cloneData(currentTargets[0])),
      restoreTargetSnapshots: currentTargets,
      distribution: "repeat-single"
    };
  }

  if (currentTargets.length > remaining) {
    return {
      ok: false,
      reason: "selected-targets-exceed-remaining",
      message: formatLocalization(
        "Notifications.TooManyTargetsForRemainingHits",
        {
          selectedCount: currentTargets.length,
          remaining
        },
        "You selected {selectedCount} target(s), but only {remaining} hit(s) remain. Reduce your selection and try again."
      ),
      details: {
        selectedCount: currentTargets.length,
        remaining
      }
    };
  }

  return {
    ok: true,
    source: "game.user.targets.current.multiple",
    targets: currentTargets,
    restoreTargetSnapshots: currentTargets,
    distribution: "one-per-target",
    selectedCount: currentTargets.length
  };
}

function getSpellSlotForContext(context, item) {
  if (typeof context?.spell?.slot === "string" && context.spell.slot) {
    return context.spell.slot;
  }

  if (typeof context?.spell?.slot === "number") {
    return context.spell.slot;
  }

  const castLevel = normalizeNonNegativeInteger(context?.castLevel, null);

  if (castLevel === null) {
    return null;
  }

  const spellcastingModel = CONFIG.DND5E.spellcasting?.[item?.system?.method];
  return spellcastingModel?.getSpellSlotKey?.(castLevel) ?? `spell${castLevel}`;
}

// Keep non-consumption options isolated so we can adjust dnd5e integration later without touching the executor flow.
function buildExtraHitUsageConfig(context, item, targetSnapshot, targetObject = null, options = {}) {
  const targetUuids = [targetSnapshot?.tokenUuid].filter(Boolean);
  const targetIds = [targetSnapshot?.tokenId].filter(Boolean);
  const targetsToUse = targetObject ? new Set([targetObject]) : new Set();

  return {
    consume: false,
    create: false,
    concentration: {
      begin: false,
      end: false
    },
    scaling: normalizeNonNegativeInteger(context?.spell?.scaling, 0) ?? 0,
    spell: {
      slot: getSpellSlotForContext(context, item)
    },
    targets: targetsToUse,
    targetIds,
    targetUuids,
    midiOptions: {
      ...cloneData(options.midiOptions ?? {}),
      targetUuids,
      targetsToUse,
      workflowOptions: {
        ...cloneData(options.midiOptions?.workflowOptions ?? {}),
        targetConfirmation: "none"
      }
    },
    subsequentActions: options.subsequentActions ?? true,
    event: options.event,
    [MODULE_ID]: {
      isExtraHit: true,
      contextId: context.id
    }
  };
}

function buildExtraHitDialogConfig(options = {}) {
  return {
    configure: false,
    options: options.dialogOptions ?? {}
  };
}

function buildExtraHitMessageConfig(context, targetSnapshot, options = {}) {
  const totalHits = getContextTotalHits(context);
  const hitsRemaining = getContextHitsRemaining(context);
  const hitIndex = Math.max(1, (totalHits - hitsRemaining) + 1);

  return {
    create: options.createMessage ?? true,
    data: {
      flags: {
        [MODULE_ID]: {
          extraHit: {
            contextId: context.id,
            hitIndex,
            extraHitIndex: hitIndex,
            target: cloneData(targetSnapshot)
          }
        }
      }
    }
  };
}

function createTargetDescriptor(targetSnapshot, tokenObject = null) {
  if (!targetSnapshot?.actorUuid) {
    return null;
  }

  const actor = tokenObject?.actor ?? tokenObject?.document?.actor ?? null;

  return {
    name: targetSnapshot.name ?? actor?.name ?? "",
    img: actor?.img ?? actor?.prototypeToken?.texture?.src ?? "",
    uuid: targetSnapshot.actorUuid,
    ac: actor?.statuses?.has?.("coverTotal") ? null : (actor?.system?.attributes?.ac?.value ?? null)
  };
}

function forceSingleTargetMessageConfig(messageConfig, targetSnapshot, tokenObject = null) {
  const descriptor = createTargetDescriptor(targetSnapshot, tokenObject);

  if (descriptor) {
    foundry.utils.setProperty(messageConfig, "data.flags.dnd5e.targets", [descriptor]);
  }

  return messageConfig;
}

function buildFailureResult(contextId, context, reason, message, details = undefined) {
  if (message) {
    notifyWarn(message, details);
  } else if (details !== undefined) {
    warn(`Extra hit resolution failed: ${reason}.`, details);
  } else {
    warn(`Extra hit resolution failed: ${reason}.`);
  }

  return {
    ok: false,
    contextId,
    context,
    reason,
    message,
    details
  };
}

function getResultMessageUuid(results) {
  return typeof results?.message?.uuid === "string"
    ? results.message.uuid
    : null;
}

function getMidiWorkflow(messageUuid) {
  return globalThis.MidiQOL?.Workflow?.getWorkflow?.(messageUuid) ?? null;
}

function isMidiWorkflowForMessage(workflow, messageUuid) {
  return Boolean(messageUuid)
    && ((workflow?.id === messageUuid) || (workflow?.itemCardUuid === messageUuid));
}

export async function waitForMidiWorkflowCompletion(results, details = {}) {
  if (!game?.modules?.get?.("midi-qol")?.active) {
    return {
      ok: true,
      skipped: true,
      reason: "midi-qol-inactive"
    };
  }

  const messageUuid = getResultMessageUuid(results);

  if (!messageUuid || typeof Hooks?.on !== "function" || typeof Hooks?.off !== "function") {
    return {
      ok: true,
      skipped: true,
      reason: "missing-message-or-hooks"
    };
  }

  const existingWorkflow = getMidiWorkflow(messageUuid);

  if (!existingWorkflow) {
    await delay(100);

    if (!getMidiWorkflow(messageUuid)) {
      return {
        ok: true,
        skipped: true,
        reason: "workflow-not-found",
        messageUuid
      };
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    let hookId = null;

    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);

      if (hookId !== null) {
        Hooks.off("midi-qol.RollComplete", hookId);
      }

      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      finish({
        ok: false,
        timedOut: true,
        messageUuid,
        ...details
      });
    }, MIDI_WORKFLOW_COMPLETION_TIMEOUT_MS);

    hookId = Hooks.on("midi-qol.RollComplete", (workflow) => {
      if (!isMidiWorkflowForMessage(workflow, messageUuid)) {
        return;
      }

      finish({
        ok: true,
        messageUuid,
        workflowId: workflow?.id ?? null,
        ...details
      });
    });
  });
}

async function useExtraActivityForTarget(context, item, hitActivity, targetSnapshot, options = {}) {
  const restoreTargetSnapshots = Array.isArray(options.restoreTargetSnapshots)
    ? options.restoreTargetSnapshots.map((snapshot) => cloneData(snapshot))
    : getCurrentUserTargetSnapshots().map((snapshot) => cloneData(snapshot));
  const selectionResult = await applyUserTargetSnapshots([targetSnapshot]);

  if (!selectionResult.ok) {
    return selectionResult;
  }

  try {
    const targetDocument = await resolveTokenDocumentFromSnapshot(targetSnapshot);
    const targetObject = resolveTokenObjectFromDocument(targetDocument);
    const usageConfig = buildExtraHitUsageConfig(context, item, targetSnapshot, targetObject, options);
    const dialogConfig = buildExtraHitDialogConfig(options);
    const messageConfig = forceSingleTargetMessageConfig(
      buildExtraHitMessageConfig(context, targetSnapshot, options),
      targetSnapshot,
      targetObject
    );

    debug("Resolving a controlled hit with a forced single-target selection.", {
      contextId: context?.id ?? null,
      target: targetSnapshot,
      forcedTargetCount: targetObject ? 1 : 0,
      forcedTargetUuids: usageConfig.targetUuids,
      hitActivity: summarizeActivity(hitActivity),
      nativeTargetCount: normalizeNonNegativeInteger(hitActivity?.target?.affects?.count, 1) ?? 1
    });

    const results = await hitActivity.use(usageConfig, dialogConfig, messageConfig);
    const completionResult = await waitForMidiWorkflowCompletion(results, {
      contextId: context?.id ?? null,
      target: cloneData(targetSnapshot)
    });

    if (!completionResult.ok) {
      debug("Timed out waiting for Midi-QOL workflow completion before changing controlled hit target.", completionResult);
    }

    return {
      ok: true,
      results
    };
  } finally {
    const restoreResult = await applyUserTargetSnapshots(restoreTargetSnapshots);

    if (!restoreResult.ok) {
      debug("Unable to restore user target selection after extra hit resolution.", {
        contextId: context?.id ?? null,
        restoreTargetSnapshots,
        restoreResult
      });
    }
  }
}

export function cancelCastContext(contextId) {
  const existingContext = getCastContext(contextId);
  const deleted = deleteCastContext(contextId);

  if (deleted) {
    notifyInfo(localize("Notifications.CastContextCanceled", "Cast context canceled."), {
      contextId
    });
  }

  return {
    ok: deleted,
    contextId,
    context: existingContext
  };
}

export async function resolveNextExtraHit(contextId, options = {}) {
  const context = getCastContext(contextId);

  if (!context) {
    return buildFailureResult(contextId, null, "missing-context", localize("Notifications.MissingContext", "The hit context no longer exists."));
  }

  if (!canCurrentUserManageContext(context)) {
    return buildFailureResult(
      contextId,
      context,
      "forbidden-user",
      localize("Notifications.ForbiddenUser", "Only the user who created this cast context can resolve its remaining hits.")
    );
  }

  if (context.resolutionMode !== "manual") {
    return buildFailureResult(
      contextId,
      context,
      "unsupported-resolution-mode",
      formatLocalization(
        "Notifications.UnsupportedResolutionMode",
        {
          mode: context.resolutionMode ?? "unknown"
        },
        "Resolution mode \"{mode}\" is not supported here."
      )
    );
  }

  if (getContextHitsRemaining(context) <= 0) {
    deleteCastContext(contextId);
    return buildFailureResult(contextId, null, "no-hits-remaining", localize("Notifications.NoHitsRemaining", "No hits remain in this context."));
  }

  const { item, actor, hitActivity } = await resolveContextDocuments(context);

  if (!item || !actor || !hitActivity) {
    return buildFailureResult(
      contextId,
      context,
      "missing-documents",
      localize("Notifications.MissingDocuments", "The spell item or hit activity could not be resolved for this context."),
      {
        itemUuid: context.itemUuid,
        actorUuid: context.actorUuid,
        hitActivityId: context.hitActivityId ?? context.extraActivityId ?? context.baseActivityId
      }
    );
  }

  const targetSupport = checkSingleTargetSupport(hitActivity);

  if (!targetSupport.ok) {
    return buildFailureResult(
      contextId,
      context,
      targetSupport.reason,
      localize("Notifications.TemplateActivitiesUnsupported", "Template-based hit activities are not supported in this controlled resolution flow."),
      {
        activity: summarizeActivity(hitActivity),
        ...targetSupport.details
      }
    );
  }

  const targetResolution = await resolveTargetForExtraHit(options);

  if (!targetResolution.ok) {
    debug("Unable to resolve a valid target for the next extra hit.", {
      contextId,
      targetResolution
    });

    return buildFailureResult(
      contextId,
      context,
      targetResolution.reason,
      targetResolution.message,
      targetResolution.details
    );
  }

  const targetSnapshot = targetResolution.target;
  const useResult = await useExtraActivityForTarget(context, item, hitActivity, targetSnapshot, options);

  if (!useResult.ok) {
    debug("Unable to apply the temporary target selection for the next extra hit.", {
      contextId,
      useResult
    });

    return buildFailureResult(
      contextId,
      context,
      useResult.reason,
      useResult.message,
      useResult.details
    );
  }

  const { results } = useResult;

  if (!results) {
    return buildFailureResult(
      contextId,
      context,
      "activity-use-cancelled",
      localize("Notifications.ActivityUseCancelled", "The hit was not resolved because the dnd5e activity did not complete.")
    );
  }

  const nextRemaining = Math.max(0, getContextHitsRemaining(context) - 1);
  const nextContext = nextRemaining > 0
    ? updateCastContext(contextId, {
      hitsRemaining: nextRemaining,
      lifecycle: {
        phase: "active",
        lastResolvedAt: new Date().toISOString(),
        lastResolvedTarget: cloneData(targetSnapshot)
      },
      lastResolvedTarget: cloneData(targetSnapshot),
      lastResolvedMessageId: typeof results?.message?.id === "string" ? results.message.id : null
    })
    : null;

  if (nextRemaining === 0) {
    deleteCastContext(contextId);
  }

  debug("Resolved one extra hit.", {
    contextId,
    targetSource: targetResolution.source,
    target: targetSnapshot,
    hitActivity: summarizeActivity(hitActivity),
    results: {
      messageId: typeof results?.message?.id === "string" ? results.message.id : null,
      messageUuid: typeof results?.message?.uuid === "string" ? results.message.uuid : null
    },
    nextRemaining
  });

  return {
    ok: true,
    contextId,
    context: nextContext,
    target: targetSnapshot,
    results,
    completed: nextRemaining === 0,
    remaining: nextRemaining
  };
}

export async function resolveRemainingExtraHits(contextId, options = {}) {
  const iterations = [];
  const context = getCastContext(contextId);

  if (!context) {
    return buildFailureResult(contextId, null, "missing-context", localize("Notifications.MissingContext", "The hit context no longer exists."));
  }

  if (!canCurrentUserManageContext(context)) {
    return buildFailureResult(
      contextId,
      context,
      "forbidden-user",
      localize("Notifications.ForbiddenUser", "Only the user who created this cast context can resolve its remaining hits.")
    );
  }

  if (context.resolutionMode !== "manual") {
    return buildFailureResult(
      contextId,
      context,
      "unsupported-resolution-mode",
      formatLocalization(
        "Notifications.UnsupportedResolutionMode",
        {
          mode: context.resolutionMode ?? "unknown"
        },
        "Resolution mode \"{mode}\" is not supported here."
      )
    );
  }

  if (getContextHitsRemaining(context) <= 0) {
    deleteCastContext(contextId);
    return buildFailureResult(contextId, null, "no-hits-remaining", localize("Notifications.NoHitsRemaining", "No hits remain in this context."));
  }

  const targetSequence = resolveTargetSnapshotsForRemainingExtraHits(context, options);

  if (!targetSequence.ok) {
    debug("Unable to resolve valid targets for resolving remaining extra hits.", {
      contextId,
      targetSequence
    });

    const failure = buildFailureResult(
      contextId,
      context,
      targetSequence.reason,
      targetSequence.message,
      targetSequence.details
    );

    return {
      ...failure,
      iterations,
      completed: false
    };
  }

  debug("Resolving remaining extra hits with a prepared target sequence.", {
    contextId,
    distribution: targetSequence.distribution,
    source: targetSequence.source,
    selectedCount: targetSequence.selectedCount ?? targetSequence.targets.length,
    resolvedCount: targetSequence.targets.length,
    limited: false
  });

  try {
    for (const targetSnapshot of targetSequence.targets) {
      const result = await resolveNextExtraHit(contextId, {
        ...options,
        targetSnapshot,
        restoreTargetSnapshots: [cloneData(targetSnapshot)]
      });
      iterations.push(result);

      if (!result.ok) {
        return {
          ok: false,
          contextId,
          context: getCastContext(contextId),
          iterations,
          completed: false,
          reason: result.reason
        };
      }

      if (result.completed) {
        break;
      }
    }
  } finally {
    const lastIteration = iterations[iterations.length - 1] ?? null;
    const finalRestoreTargetSnapshots = lastIteration?.target
      ? [cloneData(lastIteration.target)]
      : [];

    if (finalRestoreTargetSnapshots.length) {
      const restoreResult = await applyUserTargetSnapshots(finalRestoreTargetSnapshots);

      if (!restoreResult.ok) {
        debug("Unable to restore final single-target selection after resolving remaining extra hits.", {
          contextId,
          finalRestoreTargetSnapshots,
          restoreResult
        });
      }
    }
  }

  const currentContext = getCastContext(contextId);

  return {
    ok: true,
    contextId,
    context: currentContext,
    iterations,
    completed: !currentContext
  };
}
