import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

describe("Prisma Schema", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should connect to the database", async () => {
    const result = await prisma.$queryRaw`SELECT 1 as test`;
    expect(result).toEqual([{ test: BigInt(1) }]);
  });

  it("should have all four models defined", async () => {
    const tables = await prisma.$queryRaw`
      SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%'
    `;
    const tableNames = (tables as Array<{ name: string }>).map((t) => t.name).sort();
    expect(tableNames).toContain("Event");
    expect(tableNames).toContain("Participant");
    expect(tableNames).toContain("Tag");
    expect(tableNames).toContain("Assignment");
    expect(tableNames).toContain("_ParticipantToTag");
  });

  it("should create and read an Event", async () => {
    const event = await prisma.event.create({
      data: {
        name: "Test Event",
        date: new Date("2024-12-25"),
        budget: 5000,
      },
    });
    expect(event.id).toBeDefined();
    expect(event.name).toBe("Test Event");
    expect(event.budget).toBe(5000);

    const found = await prisma.event.findUnique({ where: { id: event.id } });
    expect(found).toEqual(event);
  });

  it("should create Participant with Event relation", async () => {
    const event = await prisma.event.create({
      data: {
        name: "Test Event 2",
        date: new Date("2024-12-25"),
        budget: 5000,
      },
    });

    const participant = await prisma.participant.create({
      data: {
        name: "Alice",
        email: "alice@example.com",
        eventId: event.id,
      },
    });
    expect(participant.id).toBeDefined();
    expect(participant.name).toBe("Alice");
    expect(participant.eventId).toBe(event.id);

    const found = await prisma.participant.findUnique({ where: { id: participant.id } });
    expect(found).toEqual(participant);
  });

  it("should create Tag with Event relation and unique constraint", async () => {
    const event = await prisma.event.create({
      data: {
        name: "Test Event 3",
        date: new Date("2024-12-25"),
        budget: 5000,
      },
    });

    const tag = await prisma.tag.create({
      data: {
        name: "Family",
        eventId: event.id,
      },
    });
    expect(tag.id).toBeDefined();
    expect(tag.name).toBe("Family");
    expect(tag.eventId).toBe(event.id);

    // Test unique constraint on [eventId, name]
    await expect(
      prisma.tag.create({
        data: {
          name: "Family",
          eventId: event.id,
        },
      })
    ).rejects.toThrow();
  });

  it("should create many-to-many Participant-Tag relations", async () => {
    const event = await prisma.event.create({
      data: {
        name: "Test Event 4",
        date: new Date("2024-12-25"),
        budget: 5000,
      },
    });

    const participant = await prisma.participant.create({
      data: {
        name: "Bob",
        eventId: event.id,
      },
    });

    const tag = await prisma.tag.create({
      data: {
        name: "Roommates",
        eventId: event.id,
      },
    });

    // Connect participant to tag
    await prisma.participant.update({
      where: { id: participant.id },
      data: { tags: { connect: { id: tag.id } } },
    });

    const found = await prisma.participant.findUnique({
      where: { id: participant.id },
      include: { tags: true },
    });
    expect(found?.tags).toHaveLength(1);
    expect(found?.tags[0].id).toBe(tag.id);
  });

  it("should create Assignment with giver, receiver, and magicLink", async () => {
    const event = await prisma.event.create({
      data: {
        name: "Test Event 5",
        date: new Date("2024-12-25"),
        budget: 5000,
      },
    });

    const giver = await prisma.participant.create({
      data: { name: "Giver", eventId: event.id },
    });

    const receiver = await prisma.participant.create({
      data: { name: "Receiver", eventId: event.id },
    });

    const thirdParticipant = await prisma.participant.create({
      data: { name: "Third", eventId: event.id },
    });

    const assignment = await prisma.assignment.create({
      data: {
        eventId: event.id,
        giverId: giver.id,
        receiverId: receiver.id,
      },
    });
    expect(assignment.id).toBeDefined();
    expect(assignment.giverId).toBe(giver.id);
    expect(assignment.receiverId).toBe(receiver.id);
    expect(assignment.magicLink).toBeDefined();
    expect(assignment.magicLink.length).toBe(8);

    // Test unique constraint on giverId (same giver cannot give twice)
    await expect(
      prisma.assignment.create({
        data: {
          eventId: event.id,
          giverId: giver.id,
          receiverId: thirdParticipant.id,
        },
      })
    ).rejects.toThrow();

    // Test unique constraint on receiverId (same receiver cannot receive twice)
    await expect(
      prisma.assignment.create({
        data: {
          eventId: event.id,
          giverId: thirdParticipant.id,
          receiverId: receiver.id,
        },
      })
    ).rejects.toThrow();
  });

  it("should enforce cascade delete for Event -> Participants", async () => {
    const event = await prisma.event.create({
      data: {
        name: "Test Event 6",
        date: new Date("2024-12-25"),
        budget: 5000,
      },
    });

    await prisma.participant.create({
      data: { name: "Charlie", eventId: event.id },
    });

    await prisma.event.delete({ where: { id: event.id } });

    const participants = await prisma.participant.findMany({
      where: { eventId: event.id },
    });
    expect(participants).toHaveLength(0);
  });

  it("should enforce cascade delete for Event -> Tags", async () => {
    const event = await prisma.event.create({
      data: {
        name: "Test Event 7",
        date: new Date("2024-12-25"),
        budget: 5000,
      },
    });

    await prisma.tag.create({
      data: { name: "Group", eventId: event.id },
    });

    await prisma.event.delete({ where: { id: event.id } });

    const tags = await prisma.tag.findMany({
      where: { eventId: event.id },
    });
    expect(tags).toHaveLength(0);
  });

  it("should enforce cascade delete for Event -> Assignments", async () => {
    const event = await prisma.event.create({
      data: {
        name: "Test Event 8",
        date: new Date("2024-12-25"),
        budget: 5000,
      },
    });

    const giver = await prisma.participant.create({
      data: { name: "Giver", eventId: event.id },
    });

    const receiver = await prisma.participant.create({
      data: { name: "Receiver", eventId: event.id },
    });

    await prisma.assignment.create({
      data: {
        eventId: event.id,
        giverId: giver.id,
        receiverId: receiver.id,
      },
    });

    await prisma.event.delete({ where: { id: event.id } });

    const assignments = await prisma.assignment.findMany({
      where: { eventId: event.id },
    });
    expect(assignments).toHaveLength(0);
  });
});