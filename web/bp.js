/* Clinical logic, ported one-for-one from the Android app.
   Kept in its own module with no DOM or storage dependencies so it can be
   tested directly and compared against the Kotlin it came from. */
'use strict';

export const CATEGORY = {
  NORMAL: 'NORMAL',
  ELEVATED: 'ELEVATED',
  STAGE_1: 'STAGE_1',
  STAGE_2: 'STAGE_2',
  HYPERTENSIVE_CRISIS: 'HYPERTENSIVE_CRISIS',
};

/* CalculateBPZoneUseCase. Order matters: the checks are deliberately
   evaluated most-severe first, so 190/70 is a crisis rather than "elevated". */
export function categorize(systolic, diastolic) {
  if (systolic > 180 || diastolic > 120) return CATEGORY.HYPERTENSIVE_CRISIS;
  if (systolic >= 140 || diastolic >= 90) return CATEGORY.STAGE_2;
  if ((systolic >= 130 && systolic <= 139) || (diastolic >= 80 && diastolic <= 89))
    return CATEGORY.STAGE_1;
  if (systolic >= 120 && systolic <= 129 && diastolic < 80) return CATEGORY.ELEVATED;
  return CATEGORY.NORMAL;
}

export const pulsePressure = (s, d) => s - d;
export const meanArterialPressure = (s, d) => Math.round((s + 2 * d) / 3);

export const RISK = {
  LOW: 'LOW', MODERATE: 'MODERATE', HIGH: 'HIGH', VERY_HIGH: 'VERY_HIGH',
};

export const BMI_CATEGORY = {
  UNDERWEIGHT: 'UNDERWEIGHT', NORMAL: 'NORMAL',
  OVERWEIGHT: 'OVERWEIGHT', OBESE: 'OBESE',
};

export function bmi(weightKg, heightCm) {
  if (!weightKg || !heightCm) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

export function bmiCategory(value) {
  if (value == null) return null;
  if (value < 18.5) return BMI_CATEGORY.UNDERWEIGHT;
  if (value < 25) return BMI_CATEGORY.NORMAL;
  if (value < 30) return BMI_CATEGORY.OVERWEIGHT;
  return BMI_CATEGORY.OBESE;
}

const BP_POINTS = {
  [CATEGORY.NORMAL]: 0,
  [CATEGORY.ELEVATED]: 1,
  [CATEGORY.STAGE_1]: 2,
  [CATEGORY.STAGE_2]: 3,
  [CATEGORY.HYPERTENSIVE_CRISIS]: 5,
};

/* CalculateHealthRiskUseCase.riskPoints */
export function riskPoints(category, profile = {}) {
  let pts = BP_POINTS[category] ?? 0;
  const age = profileAge(profile);
  if (age != null) {
    if (age >= 75) pts += 3;
    else if (age >= 65) pts += 2;
    else if (age >= 55) pts += 1;
  }
  if (profile.sex === 'MALE') pts += 1;
  const bc = bmiCategory(bmi(profile.weightKg, profile.heightCm));
  if (bc === BMI_CATEGORY.OBESE) pts += 2;
  else if (bc === BMI_CATEGORY.OVERWEIGHT) pts += 1;
  if (profile.smoker) pts += 2;
  if (profile.diabetes) pts += 2;
  if (profile.activity === 'SEDENTARY') pts += 1;
  return pts;
}

/* CalculateHealthRiskUseCase.mapRisk */
export function mapRisk(category, pts) {
  if (category === CATEGORY.HYPERTENSIVE_CRISIS) return RISK.VERY_HIGH;
  if (category === CATEGORY.STAGE_2 && pts >= 6) return RISK.VERY_HIGH;
  if (category === CATEGORY.STAGE_2) return RISK.HIGH;
  if (category === CATEGORY.STAGE_1 && pts >= 7) return RISK.HIGH;
  if (category === CATEGORY.STAGE_1) return RISK.MODERATE;
  if (category === CATEGORY.ELEVATED && pts >= 5) return RISK.MODERATE;
  if (pts >= 8) return RISK.MODERATE;
  return RISK.LOW;
}

export function profileAge(profile) {
  if (!profile || !profile.birthYear) return null;
  return new Date().getFullYear() - profile.birthYear;
}

export function assess(systolic, diastolic, profile = {}) {
  const category = categorize(systolic, diastolic);
  const pts = riskPoints(category, profile);
  const value = bmi(profile.weightKg, profile.heightCm);
  return {
    category,
    risk: mapRisk(category, pts),
    points: pts,
    bmi: value,
    bmiCategory: bmiCategory(value),
    map: meanArterialPressure(systolic, diastolic),
    pulsePressure: pulsePressure(systolic, diastolic),
  };
}
