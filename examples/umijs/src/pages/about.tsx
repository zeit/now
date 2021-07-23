import React from 'react';

export default function About() {
  const [count, setCount] = React.useState(0);
  return (
    <div>
      This is about Page, <code>src/pages/about.tsx</code> and save to reload.
    </div>
  );
}
