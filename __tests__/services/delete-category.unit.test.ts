/**
 * Unit Tests: deleteCategory — existing projects guard
 *
 * Requirements: 1.5
 *
 * Requirement 1.5:
 *   IF Admin tries to delete a category that already has projects registered,
 *   THEN THE System SHALL display a confirmation message and prevent deletion
 *   until Admin confirms migration or removal of related projects.
 *
 * These tests verify the service-layer enforcement of that guard:
 *   - When a category has ≥ 1 project, deleteCategory throws an error with
 *     code "CATEGORY_HAS_PROJECTS" (HTTP 409 equivalent).
 *   - When a category has 0 projects, deleteCategory resolves successfully
 *     and calls db.category.delete once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock the Prisma db singleton BEFORE importing the service, so the service
// picks up the mock instance at module resolution time.
// ---------------------------------------------------------------------------
vi.mock('@/lib/db', () => {
  const db = {
    project: {
      count: vi.fn(),
    },
    category: {
      delete: vi.fn(),
    },
  }
  return { db, prisma: db }
})

import { db } from '@/lib/db'
import { deleteCategory } from '@/lib/services/category.service'

// Cast the mocked functions for convenient type-safe usage in tests.
const mockProjectCount = vi.mocked(db.project.count)
const mockCategoryDelete = vi.mocked(db.category.delete)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deleteCategory — requirements 1.5', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Test 1: Category HAS projects → rejection with CATEGORY_HAS_PROJECTS code
  // -------------------------------------------------------------------------
  it('throws an error with code CATEGORY_HAS_PROJECTS when the category has projects', async () => {
    const categoryId = 'cat_test001'

    // Simulate 3 projects associated with this category
    mockProjectCount.mockResolvedValueOnce(3)

    await expect(deleteCategory(categoryId)).rejects.toSatisfy(
      (err: unknown) => {
        const e = err as Error & { code?: string }
        return (
          e instanceof Error &&
          e.code === 'CATEGORY_HAS_PROJECTS' &&
          e.message.includes('3')
        )
      },
    )

    // Ensure db.project.count was called with the right filter
    expect(mockProjectCount).toHaveBeenCalledOnce()
    expect(mockProjectCount).toHaveBeenCalledWith({ where: { categoryId } })

    // Crucially, the category delete must NOT have been called
    expect(mockCategoryDelete).not.toHaveBeenCalled()
  })

  it('throws even when there is exactly 1 project (boundary check)', async () => {
    const categoryId = 'cat_one_project'

    mockProjectCount.mockResolvedValueOnce(1)

    await expect(deleteCategory(categoryId)).rejects.toSatisfy(
      (err: unknown) => (err as { code?: string }).code === 'CATEGORY_HAS_PROJECTS',
    )

    expect(mockCategoryDelete).not.toHaveBeenCalled()
  })

  it('error message includes the project count', async () => {
    const categoryId = 'cat_count_in_msg'

    mockProjectCount.mockResolvedValueOnce(7)

    let caughtError: Error | undefined
    try {
      await deleteCategory(categoryId)
    } catch (err) {
      caughtError = err as Error
    }

    expect(caughtError).toBeDefined()
    expect(caughtError?.message).toMatch(/7/)
  })

  // -------------------------------------------------------------------------
  // Test 2: Category has NO projects → successful deletion
  // -------------------------------------------------------------------------
  it('deletes the category when there are no projects', async () => {
    const categoryId = 'cat_empty001'
    const deletedCategory = {
      id: categoryId,
      eventId: 'evt_001',
      name: 'Empty Category',
      description: null,
      isPublished: false,
      publicToken: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    mockProjectCount.mockResolvedValueOnce(0)
    mockCategoryDelete.mockResolvedValueOnce(deletedCategory)

    const result = await deleteCategory(categoryId)

    // Guard: should NOT throw
    expect(result).toBeDefined()

    // Verify the count check happened with correct filter
    expect(mockProjectCount).toHaveBeenCalledOnce()
    expect(mockProjectCount).toHaveBeenCalledWith({ where: { categoryId } })

    // Verify the actual delete was called
    expect(mockCategoryDelete).toHaveBeenCalledOnce()
    expect(mockCategoryDelete).toHaveBeenCalledWith({ where: { id: categoryId } })
  })

  it('returns the deleted category record when deletion succeeds', async () => {
    const categoryId = 'cat_return_val'
    const deletedCategory = {
      id: categoryId,
      eventId: 'evt_001',
      name: 'Returnable Category',
      description: 'A category to test the return value',
      isPublished: false,
      publicToken: null,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-02'),
    }

    mockProjectCount.mockResolvedValueOnce(0)
    mockCategoryDelete.mockResolvedValueOnce(deletedCategory)

    const result = await deleteCategory(categoryId)

    expect(result).toEqual(deletedCategory)
  })

  // -------------------------------------------------------------------------
  // Ensure each test is isolated: mock state does not leak between tests
  // -------------------------------------------------------------------------
  it('does not call db.category.delete if project count throws', async () => {
    const categoryId = 'cat_db_error'

    mockProjectCount.mockRejectedValueOnce(new Error('DB connection lost'))

    await expect(deleteCategory(categoryId)).rejects.toThrow('DB connection lost')

    expect(mockCategoryDelete).not.toHaveBeenCalled()
  })
})
