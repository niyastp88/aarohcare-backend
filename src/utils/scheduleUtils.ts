export const formatTimeStandard = (timeStr: string): { time: string; displayTime: string } => {
  const parts = (timeStr || '').split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  const hours = String(h).padStart(2, '0');
  const minutes = String(m).padStart(2, '0');
  const period = h >= 12 ? 'PM' : 'AM';
  const displayH = h % 12 === 0 ? 12 : h % 12;
  const displayTime = `${String(displayH).padStart(2, '0')}:${minutes} ${period}`;
  return {
    time: `${hours}:${minutes}`,
    displayTime,
  };
};

export const buildSlots = (
  startTime: string,
  endTime: string,
  intervalMinutes: number,
) => {
  const slots: Array<{ time: string; displayTime: string; isBooked: boolean }> = [];
  const [startH, startM] = startTime.split(':').map(Number);
  const [endH, endM] = endTime.split(':').map(Number);

  let current = (startH || 0) * 60 + (startM || 0);
  const end = (endH || 0) * 60 + (endM || 0);

  while (current < end) {
    const h = Math.floor(current / 60);
    const m = current % 60;
    const hours = String(h).padStart(2, '0');
    const minutes = String(m).padStart(2, '0');
    const period = h >= 12 ? 'PM' : 'AM';
    const displayH = h % 12 === 0 ? 12 : h % 12;
    const displayTime = `${String(displayH).padStart(2, '0')}:${minutes} ${period}`;

    slots.push({
      time: `${hours}:${minutes}`,
      displayTime,
      isBooked: false,
    });
    current += intervalMinutes;
  }

  return slots;
};
