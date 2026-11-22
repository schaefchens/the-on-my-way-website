// A small Reanimated stand-in for component tests: values jump to their targets, Animated.* are
// plain views, and the layout animations are chainable no-ops. Motion itself is checked on the
// emulator (screenshots), not here.
const React = require('react');
const { View, Text, ScrollView, Image } = require('react-native');

const identity = (v) => v;
const anim = (to, _config, done) => {
  if (typeof done === 'function') done(true);
  return to;
};
const chain = () => {
  const c = {};
  for (const k of ['duration', 'delay', 'reduceMotion', 'springify', 'damping', 'easing', 'withInitialValues'])
    c[k] = () => c;
  return c;
};
const createAnimatedComponent = (C) =>
  React.forwardRef(({ animatedProps, entering, exiting, layout, ...props }, ref) =>
    React.createElement(C, { ...props, ...(animatedProps ?? {}), ref }),
  );

module.exports = {
  __esModule: true,
  default: { View, Text, ScrollView, Image, createAnimatedComponent },
  View,
  Text,
  createAnimatedComponent,
  useSharedValue: (v) => {
    const ref = React.useRef({ value: v });
    return ref.current;
  },
  useAnimatedStyle: (fn) => fn(),
  useAnimatedProps: (fn) => fn(),
  useDerivedValue: (fn) => ({ value: fn() }),
  useReducedMotion: () => false,
  isSharedValue: (v) => typeof v === 'object' && v !== null && v.__isShared === true,
  withTiming: anim,
  withSpring: anim,
  withDelay: (_d, v) => v,
  withSequence: (...vs) => vs[vs.length - 1],
  interpolate: (x, input, output) => {
    const [i0, i1] = [input[0], input[input.length - 1]];
    const [o0, o1] = [output[0], output[output.length - 1]];
    const t = Math.max(0, Math.min(1, (x - i0) / (i1 - i0 || 1)));
    return o0 + (o1 - o0) * t;
  },
  Easing: { bezier: () => identity, linear: identity, out: identity, in: identity },
  ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
  FadeIn: chain(),
  FadeOut: chain(),
};
