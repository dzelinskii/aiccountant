import {
  Alert,
  Anchor,
  Button,
  Container,
  Paper,
  PasswordInput,
  TextInput,
  Title,
} from '@mantine/core'
import { useForm } from '@mantine/form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { register } from '../api/auth'
import { ApiError } from '../api/client'

export function RegisterPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const form = useForm({
    initialValues: { email: '', password: '' },
    validate: {
      email: (v) => (/^\S+@\S+$/.test(v) ? null : 'Некорректный email'),
      password: (v) => (v.length >= 8 ? null : 'Минимум 8 символов'),
    },
  })
  const mutation = useMutation({
    mutationFn: (values: { email: string; password: string }) =>
      register(values.email, values.password),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      navigate('/')
    },
  })

  return (
    <Container size={420} my={80}>
      <Title ta="center">Регистрация</Title>
      <Paper withBorder shadow="sm" p="lg" mt="lg" radius="md">
        <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
          <TextInput label="Email" placeholder="you@example.com" {...form.getInputProps('email')} />
          <PasswordInput
            label="Пароль"
            description="Минимум 8 символов"
            mt="md"
            {...form.getInputProps('password')}
          />
          {mutation.isError && (
            <Alert color="red" mt="md">
              {mutation.error instanceof ApiError && mutation.error.status === 409
                ? 'Такой email уже зарегистрирован'
                : 'Не удалось зарегистрироваться, попробуйте ещё раз'}
            </Alert>
          )}
          <Button type="submit" fullWidth mt="xl" loading={mutation.isPending}>
            Создать аккаунт
          </Button>
        </form>
        <Anchor component={Link} to="/login" size="sm" mt="md" display="block" ta="center">
          Уже есть аккаунт? Войти
        </Anchor>
      </Paper>
    </Container>
  )
}
