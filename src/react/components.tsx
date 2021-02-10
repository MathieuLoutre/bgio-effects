import React, { useCallback, useEffect, useRef, useState } from 'react';
import useRafLoop from 'react-use/lib/useRafLoop';
import useUpdate from 'react-use/lib/useUpdate';
import mitt from 'mitt';
import type { Emitter } from 'mitt';
import type { BoardProps } from 'boardgame.io/react';
import type { Data, Queue } from '../types';
import type { InternalEffectShape } from './types';
import {
  EffectsContext,
  EffectsPropsContext,
  // EffectsQueueContext,
} from './contexts';

/**
 * Configuration options that can be passed to EffectsBoardWrapper.
 */
interface EffectsOpts {
  speed?: number;
  updateStateAfterEffects?: boolean;
}

/**
 * Returns a component that will render your board wrapped in
 * an effect emitting context provider.
 * @param board - The board component to wrap.
 * @param opts  - Optional object to configure options for effect emitter.
 *
 * @example
 * import { EffectsBoardWrapper } from 'bgio-effects'
 * import MyBoard from './board.js'
 * const BoardWithEffects = EffectsBoardWrapper(MyBoard)
 */
export function EffectsBoardWrapper<
  G extends any = any,
  P extends BoardProps<G> = BoardProps<G>
>(Board: React.ComponentType<P>, opts?: EffectsOpts): React.ComponentType<P> {
  return function BoardWithEffectsProvider(boardProps: P) {
    return EffectsProvider<G, P>({ boardProps, Board, opts });
  };
}

/**
 * Hook very similar to `useState` except that state is stored in a ref.
 * This allows the requestAnimationFrame loop to access the latest state
 * before React rerenders, but also update React as `setState` would usually.
 */
function useRefState<T>(initial: T) {
  const state = useRef(initial);
  const rerender = useUpdate();
  const setState = useCallback(
    (newState: T) => {
      state.current = newState;
      rerender();
    },
    [state, rerender]
  );
  return [state, setState] as const;
}

/**
 * Emit an effect from the provided emitter, bundling payload and boardProps
 * into the effect object.
 */
function emit(
  emitter: Emitter,
  { type, payload }: Queue[number],
  boardProps: BoardProps
) {
  const effect: InternalEffectShape = { payload, boardProps };
  emitter.emit(type, effect);
}

/**
 * Dispatch all effects in the provided queue via the provided emitter.
 * @param emitter - Mitt instance.
 * @param effects - React ref for the effects queue to process.
 */
function emitAllEffects(
  emitter: Emitter,
  effects: Queue,
  boardProps: BoardProps
) {
  for (const effect of effects) {
    emit(emitter, effect, boardProps);
  }
}

interface InteralState {
  prevId: string | undefined;
  startT: number;
  bgioProps: BoardProps;
}

interface QueueState {
  queue: Queue;
  activeQueue: Queue;
}

/**
 * Context provider that watches boardgame.io state and emits effect events.
 */
function EffectsProvider<
  G extends any = any,
  P extends BoardProps<G> = BoardProps<G>
>({
  Board,
  boardProps,
  opts: { speed = 1, updateStateAfterEffects = false } = {},
}: {
  Board: React.ComponentType<P>;
  boardProps: P;
  opts?: EffectsOpts;
}) {
  const { effects } = boardProps.plugins as { effects?: { data: Data } };
  const id = effects && effects.data.id;
  const duration = (effects && effects.data.duration) || 0;
  const bgioStateT: number = updateStateAfterEffects ? duration : 0;
  const [emitter] = useState(() => mitt());
  const [endEmitter] = useState(() => mitt());

  const [state, setState] = useState<InteralState>({
    prevId: id,
    startT: 0,
    bgioProps: boardProps,
  });

  // const { bgioProps } = state;

  const [qState, setQueueState] = useRefState<QueueState>({
    queue: [],
    activeQueue: [],
  });

  // const [prevId, setPrevId] = useState<string | undefined>(id);
  // const [startT, setStartT] = useState(0);
  // const [bgioProps, setBgioProps] = useState(boardProps);
  // const [queue, setQueue] = useRefState<Queue>([]);
  // const [activeQueue, setActiveQueue] = useRefState<Queue>([]);

  /**
   * requestAnimationFrame loop which dispatches effects and updates the queue
   * every tick while active.
   */
  const [stopRaf, startRaf, isRafActive] = useRafLoop(() => {
    const elapsedT = ((performance.now() - state.startT) / 1000) * speed;
    const newActiveQueue: Queue = [];
    // Loop through the queue of active effects.
    let ended = false;
    for (let i = 0; i < qState.current.activeQueue.length; i++) {
      const effect = qState.current.activeQueue[i];
      if (effect.endT > elapsedT) {
        newActiveQueue.push(effect);
        continue;
      }
      emit(endEmitter, effect, boardProps);
      ended = true;
    }
    // Loop through the effects queue, emitting any effects whose time has come.
    let i = 0;
    for (i = 0; i < qState.current.queue.length; i++) {
      const effect = qState.current.queue[i];
      if (effect.t > elapsedT) break;
      emit(emitter, effect, boardProps);
      newActiveQueue.push(effect);
    }

    // Also update the global boardgame.io props once their time is reached.
    if (elapsedT >= bgioStateT && boardProps !== state.bgioProps) {
      console.log('BGIO-EFFECT', 'raf', 'bgioprops');

      setState({
        ...state,
        bgioProps: boardProps,
      });
    }

    if (elapsedT > duration) stopRaf();

    const updateQueue: QueueState = { ...qState.current };

    // Update the queue to only contain effects still in the future.
    if (i > 0 || ended) {
      updateQueue.activeQueue = newActiveQueue;

      if (i > 0) {
        updateQueue.queue = qState.current.queue.slice(i);
      }

      console.log('BGIO-EFFECT', 'raf', 'queuestate');

      setQueueState(updateQueue);
    }
  }, false);

  /**
   * Update the queue state when a new update is received from boardgame.io.
   */
  useEffect(() => {
    const update: InteralState = { ...state };

    console.log('BGIO-EFFECT', 'useEffect');

    if (!effects || id === state.prevId) {
      // If some non-game state props change, or the effects plugin is not
      // enabled, still update boardgame.io props for the board component.
      if (
        (!updateStateAfterEffects || !isRafActive()) &&
        boardProps !== state.bgioProps
      ) {
        console.log('BGIO-EFFECT', 'useEffect', 'bgioprops');

        update.bgioProps = boardProps;
        setState(update);
      }
      return;
    }

    update.prevId = effects.data.id;

    emitAllEffects(endEmitter, qState.current.activeQueue, boardProps);

    setQueueState({
      queue: effects.data.queue,
      activeQueue: [],
    });

    update.startT = performance.now();

    console.log('BGIO-EFFECT', 'useEffect', 'queue & state');
    setState(update);

    startRaf();
  }, [
    effects,
    id,
    state,
    updateStateAfterEffects,
    isRafActive,
    boardProps,
    endEmitter,
    startRaf,
    setQueueState,
    qState,
  ]);

  // /**
  //  * Callback that clears the effect queue, cancelling future effects and
  //  * immediately calling any outstanding onEnd callbacks.
  //  */
  // const clear = useCallback(() => {
  //   console.log("BGIO-EFFECT", 'clear')

  //   stopRaf();
  //   emitAllEffects(endEmitter, qState.current.activeQueue, boardProps);
  //   setQueueState({
  //     queue: [],
  //     activeQueue: [],
  //   });
  //   if (boardProps !== state.bgioProps) {
  //     setState({
  //       ...state,
  //       bgioProps: boardProps,
  //     });
  //   }
  // }, [stopRaf, endEmitter, qState, setQueueState, boardProps, state]);

  // /**
  //  * Callback that immediately emits all remaining effects and clears the queue.
  //  * When flushing, onEnd callbacks are run immediately.
  //  */
  // const flush = useCallback(() => {
  //   console.log("BGIO-EFFECT", 'flush')
  //   emitAllEffects(emitter, qState.current.queue, boardProps);
  //   clear();
  // }, [emitter, qState, clear, boardProps]);

  // /**
  //  * Callback that updates the props to the latest props received
  //  */
  // const update = useCallback(() => {
  //   console.log("BGIO-EFFECT", 'update')

  //   if (boardProps !== bgioProps) {
  //     setState((state) => ({
  //       ...state,
  //       bgioProps: boardProps,
  //     }));
  //   }
  // }, [boardProps, bgioProps]);

  console.log('BGIO-EFFECT', 'queue size', qState.current.queue.length);

  return (
    <EffectsContext.Provider value={{ emitter, endEmitter }}>
      {/* <EffectsQueueContext.Provider
        value={{ clear, flush, update }} // size: qState.current.queue.length
      > */}
      <EffectsPropsContext.Provider value={state.bgioProps}>
        <Board {...(state.bgioProps as P)} />
      </EffectsPropsContext.Provider>
      {/* </EffectsQueueContext.Provider> */}
    </EffectsContext.Provider>
  );
}
