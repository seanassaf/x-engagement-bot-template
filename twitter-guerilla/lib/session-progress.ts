import type { SessionArgs } from './types.ts';

export type SessionProgress = {
  likes: number;
  comments: number;
};

export type SessionPlan = {
  complete: boolean;
  likesRemaining: number;
  commentsRemaining: number;
  shouldLike: boolean;
  shouldComment: boolean;
  targetCount: number;
};

export function buildSessionPlan(
  goals: Pick<SessionArgs, 'likes' | 'comments'>,
  progress: SessionProgress,
): SessionPlan {
  const likesRemaining = Math.max(goals.likes - progress.likes, 0);
  const commentsRemaining = Math.max(goals.comments - progress.comments, 0);
  const complete = likesRemaining === 0 && commentsRemaining === 0;

  return {
    complete,
    likesRemaining,
    commentsRemaining,
    shouldLike: likesRemaining > 0,
    shouldComment: commentsRemaining > 0,
    targetCount: complete ? 0 : Math.max(likesRemaining, commentsRemaining, 1),
  };
}
