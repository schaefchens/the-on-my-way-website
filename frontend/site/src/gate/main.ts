/**
 * Entry of the gate bundle (spec-wave5 §6.1): the static pages /_/{join,info,wait,ended,me,panic}/
 * of the gate tree load this module and its CSS. Vanilla TypeScript (no React, no Lingui runtime,
 * no zod in production): it is public, so it stays small and says nothing about the site.
 */
import './gate.css';
import { mountGate } from './app';
import { readGateBoot } from './boot';
import { browserEnv } from './env';

void mountGate(browserEnv(), readGateBoot(document));
