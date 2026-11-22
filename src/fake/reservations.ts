// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

import { StatusError } from "@the-protobuf-project/errors";
import type { HoldName } from "../../gen/freebusy/allocation/v1/index.ts";
import type {
  CancelReservationRequest,
  CreateReservationRequest,
  GetReservationRequest,
  ListReservationsRequest,
  ListReservationsResponse,
  RescheduleReservationRequest,
  Reservation,
  ReservationName,
  ReservationService,
  UpdateReservationRequest,
} from "../../gen/freebusy/reservation/v1/index.ts";
import { type Club, iso, noFilter } from "./ledger.ts";

/** ReservationService over the in-memory club: confirms holds as bookings. */
export function reservationService(club: Club): ReservationService {
  /** Converts a live hold into a confirmed reservation; a hold backs at most one. */
  function confirm(holdName: HoldName, fields: Partial<Reservation>, id?: string): Reservation {
    const existing = [...club.reservations.values()].find((r) => r.hold === holdName);
    if (existing) return existing;
    const hold = club.hold(holdName);
    if (hold.state !== "HOLD_STATE_ACTIVE") {
      throw new StatusError("FAILED_PRECONDITION", `${holdName} is ${hold.state}: take a new hold`, {
        reason: "HOLD_NOT_ACTIVE",
      });
    }
    const now = iso(club.now());
    const name = `reservations/${id || club.id("r")}` as ReservationName;
    const reservation: Reservation = {
      ...fields,
      name,
      hold: holdName,
      resources: hold.resources ?? [],
      startTime: hold.window.startTime ?? "",
      endTime: hold.window.endTime ?? "",
      state: "RESERVATION_STATE_CONFIRMED",
      createTime: now,
      updateTime: now,
      confirmTime: now,
      etag: club.id("e"),
    };
    hold.state = "HOLD_STATE_CONVERTED";
    hold.updateTime = now;
    club.reservations.set(name, reservation);
    return reservation;
  }

  function confirmed(name: ReservationName): Reservation {
    const reservation = club.reservation(name);
    if (reservation.state !== "RESERVATION_STATE_CONFIRMED") {
      throw new StatusError("FAILED_PRECONDITION", `${name} is ${reservation.state}, not confirmed`);
    }
    return reservation;
  }

  return {
    async createReservation({ reservation, reservationId }: CreateReservationRequest): Promise<Reservation> {
      const { customer, attributes } = reservation;
      return confirm(reservation.hold, { customer, attributes }, reservationId);
    },

    async getReservation({ name }: GetReservationRequest): Promise<Reservation> {
      return club.reservation(name);
    },

    async listReservations({ filter }: ListReservationsRequest): Promise<ListReservationsResponse> {
      noFilter(filter);
      return { reservations: [...club.reservations.values()] };
    },

    async updateReservation({ reservation, updateMask }: UpdateReservationRequest): Promise<Reservation> {
      const stored = confirmed(reservation.name ?? ("" as ReservationName));
      if (reservation.etag && reservation.etag !== stored.etag) {
        throw new StatusError("ABORTED", "etag does not match: the reservation changed since you read it");
      }
      const mask = updateMask ? updateMask.split(",") : ["customer", "attributes"];
      for (const path of mask) {
        if (path === "customer") stored.customer = reservation.customer ?? "";
        else if (path === "attributes") stored.attributes = reservation.attributes ?? {};
        else throw new StatusError("INVALID_ARGUMENT", `update_mask: ${path} cannot change; reschedule or cancel`);
      }
      stored.updateTime = iso(club.now());
      stored.etag = club.id("e");
      return stored;
    },

    async cancelReservation({ name, reason }: CancelReservationRequest): Promise<Reservation> {
      const reservation = club.reservation(name);
      if (reservation.state === "RESERVATION_STATE_CANCELLED") return reservation;
      confirmed(name);
      const now = iso(club.now());
      Object.assign(reservation, { state: "RESERVATION_STATE_CANCELLED", cancelReason: reason ?? "", cancelTime: now });
      reservation.updateTime = now;
      club.drop(reservation.hold);
      return reservation;
    },

    async rescheduleReservation({ name, hold }: RescheduleReservationRequest): Promise<Reservation> {
      const original = club.reservation(name);
      if (original.replacement) return club.reservation(original.replacement as ReservationName);
      confirmed(name);
      const { customer, attributes } = original;
      const replacement = confirm(hold, { customer, attributes, replaces: name });
      Object.assign(original, { state: "RESERVATION_STATE_RESCHEDULED", replacement: replacement.name });
      original.updateTime = iso(club.now());
      club.drop(original.hold);
      return replacement;
    },
  };
}
